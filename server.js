import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from './lib/languages.js';
import { publicEpisode, publicLanguage, readSeriesConfig, scanSeries, transcript } from './lib/library.js';
import { deeplUsage, linguee, LookupError, pons, ponsVerb, translate, translateWithDeepl, wiktionary } from './lib/lookup.js';
import { episodeFile, MediaProblem, sendFileWithRange } from './lib/media.js';
import { intervalLabel } from './lib/srs.js';
import { applyEdits, Store } from './lib/store.js';
import { addAnchor, syncRows } from './lib/sync.js';
import { TranslationCache } from './lib/translation-cache.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const PORT = Number(process.env.PORT ?? 3131);
const SERIES_FILE = process.env.SERIES_FILE ?? path.join(HERE, 'series.json');
const SHOW_ROOT = process.env.SHOW_ROOT ?? '/Volumes/mccann_ssd/31 minutos'; // used when there is no series.json
const CACHE_DIR = process.env.MEDIA_CACHE_DIR ?? path.join(os.homedir(), 'Library/Caches/31-palabras');
const CACHE_KEEP = Number(process.env.MEDIA_CACHE_EPISODES ?? 5);
const DEEPL_API_KEY = process.env.DEEPL_API_KEY ?? '';
const DEEPL_API_URL = process.env.DEEPL_API_URL;
const MAX_QUERY_LENGTH = 400;
const MAX_LINE_LENGTH = 2000;

const DATA_DIR = process.env.DATA_DIR ?? path.join(HERE, 'data');
const store = new Store(DATA_DIR);
const savedTranslations = new TranslationCache(path.join(DATA_DIR, 'translations.json'));

let library;
try {
  library = readSeriesConfig(SERIES_FILE, SHOW_ROOT).map((series) => ({ ...series, episodes: scanSeries(series) }));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// A drive may have been plugged in since the last scan.
function rescanMissing() {
  for (const series of library) {
    if (!series.episodes.length) series.episodes = scanSeries(series);
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 100_000) reject(new HttpError(413, 'Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function findEpisode(id) {
  rescanMissing();
  const episode = library.flatMap((series) => series.episodes).find((e) => e.id === id);
  if (!episode) throw new HttpError(404, 'Episode not found');
  return episode;
}

function syncResponse(episode, rows) {
  const anchors = store.syncFor(episode.id);
  return { synced: anchors.length > 0, rows: syncRows(rows, anchors).map(({ id, start, end, synced }) => ({ id, start, end, synced })) };
}

function cardWithPreview(card) {
  return { ...card, previews: [0, 1, 2, 3].map((grade) => intervalLabel(card, grade)) };
}

function queryParams(url) {
  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q || q.length > MAX_QUERY_LENGTH) throw new HttpError(400, 'Query must be 1-400 characters');
  const requested = url.searchParams.get('lang');
  const lang = Object.hasOwn(LANGUAGES, requested ?? '') ? requested : 'es';
  return { q, lang, from: url.searchParams.get('from') === 'en' ? 'en' : lang, context: url.searchParams.get('context') ?? '' };
}

function exportTsv() {
  const cell = (value) => String(value ?? '').replace(/[\t\r\n]+/g, ' ');
  const lines = store.listCards().map((c) =>
    [c.term, c.meaning, c.note, c.contextStudy, c.contextEn, c.seriesTitle, c.episodeTitle, c.lang].map(cell).join('\t'));
  return `#separator:tab\n#columns:Term\tMeaning\tNote\tContext\tEnglish context\tSeries\tEpisode\tLanguage\n${lines.join('\n')}\n`;
}

const routes = [
  ['GET', /^\/api\/episodes$/, () => {
    rescanMissing();
    return {
      series: library.map((series) => ({
        id: series.id,
        title: series.title,
        root: series.root,
        language: publicLanguage(series.language),
        available: fs.existsSync(series.root),
        episodes: series.episodes.map(publicEpisode),
      })),
    };
  }],
  ['GET', /^\/api\/episodes\/([\w-]+)$/, async ({ match }) => {
    const episode = findEpisode(match[1]);
    const { rows, estimated } = await transcript(episode);
    return {
      ...publicEpisode(episode),
      estimated,
      rows: syncRows(applyEdits(rows, store.editsFor(episode.id)), store.syncFor(episode.id)),
      synced: store.syncFor(episode.id).length > 0,
      deepl: Boolean(DEEPL_API_KEY),
      highlights: store.highlightsFor(episode.id),
    };
  }],
  ['POST', /^\/api\/episodes\/([\w-]+)\/sync$/, async ({ req, match }) => {
    const episode = findEpisode(match[1]);
    const { rows } = await transcript(episode);
    const { rowId, time } = await readJson(req);
    if (!rows[rowId]) throw new HttpError(404, 'Line not found');
    if (!Number.isFinite(time) || time < 0) throw new HttpError(400, 'Invalid time');
    store.setSync(episode.id, addAnchor(store.syncFor(episode.id), { from: rows[rowId].start, to: time }));
    return syncResponse(episode, rows);
  }],
  // With ?rowId, releases that line; without, clears the episode's sync.
  ['DELETE', /^\/api\/episodes\/([\w-]+)\/sync$/, async ({ url, match }) => {
    const episode = findEpisode(match[1]);
    const { rows } = await transcript(episode);
    const rowId = url.searchParams.get('rowId');
    const from = rowId === null ? null : rows[Number(rowId)]?.start;
    store.setSync(episode.id, rowId === null ? [] : store.syncFor(episode.id).filter((a) => a.from !== from));
    return syncResponse(episode, rows);
  }],
  ['PUT', /^\/api\/episodes\/([\w-]+)\/rows\/(\d+)$/, async ({ req, match }) => {
    const episode = findEpisode(match[1]);
    const rowId = Number(match[2]);
    const { rows } = await transcript(episode);
    if (!rows[rowId]) throw new HttpError(404, 'Line not found');
    const body = await readJson(req);
    for (const side of ['study', 'en']) {
      if (body[side] === undefined) continue;
      if (typeof body[side] !== 'string' || body[side].length > MAX_LINE_LENGTH) throw new HttpError(400, 'Invalid text');
      store.saveEdit({ episodeId: episode.id, rowId, side, original: rows[rowId][side], text: body[side].trim() });
    }
    return {
      row: applyEdits(rows, store.editsFor(episode.id))[rowId],
      highlights: store.highlightsFor(episode.id),
    };
  }],
  ['GET', /^\/api\/lookup\/linguee$/, ({ url }) => {
    const { q, from, lang } = queryParams(url);
    return linguee(q, from, lang);
  }],
  ['GET', /^\/api\/lookup\/pons$/, ({ url }) => {
    const { q, from, lang } = queryParams(url);
    return pons(q, from, lang);
  }],
  ['GET', /^\/api\/lookup\/pons-verb$/, ({ url }) => {
    const { q, lang } = queryParams(url);
    return ponsVerb(q, lang);
  }],
  ['GET', /^\/api\/lookup\/wiktionary$/, ({ url }) => {
    const { q, from } = queryParams(url);
    return wiktionary(q, from);
  }],
  ['GET', /^\/api\/lookup\/translate$/, ({ url }) => {
    const { q, from, lang } = queryParams(url);
    return translate(q, from, lang);
  }],
  ['GET', /^\/api\/lookup\/deepl$/, ({ url }) => {
    if (!DEEPL_API_KEY) throw new HttpError(404, 'No DeepL key is set');
    const { q, from, lang, context } = queryParams(url);
    return translateWithDeepl(q, from, lang, { context, key: DEEPL_API_KEY, baseUrl: DEEPL_API_URL, saved: savedTranslations });
  }],
  ['GET', /^\/api\/deepl-usage$/, async () => (DEEPL_API_KEY
    ? { configured: true, ...(await deeplUsage(DEEPL_API_KEY, DEEPL_API_URL)) }
    : { configured: false })],
  ['GET', /^\/api\/cards$/, () => store.listCards().map(cardWithPreview)],
  ['POST', /^\/api\/cards$/, async ({ req }) => {
    const fields = await readJson(req);
    if (typeof fields.term !== 'string' || !fields.term.trim()) throw new HttpError(400, 'A card needs a term');
    const { card, duplicate } = store.addCard(fields);
    return { card: cardWithPreview(card), duplicate };
  }],
  ['PATCH', /^\/api\/cards\/([\w-]+)$/, async ({ req, match }) => {
    const card = store.updateCard(match[1], await readJson(req));
    if (!card) throw new HttpError(404, 'Card not found');
    return cardWithPreview(card);
  }],
  ['DELETE', /^\/api\/cards\/([\w-]+)$/, ({ match }) => {
    if (!store.deleteCard(match[1])) throw new HttpError(404, 'Card not found');
    return { ok: true };
  }],
  ['POST', /^\/api\/cards\/([\w-]+)\/review$/, async ({ req, match }) => {
    const { grade } = await readJson(req);
    if (![0, 1, 2, 3].includes(grade)) throw new HttpError(400, 'Grade must be 0-3');
    const card = store.reviewCard(match[1], grade);
    if (!card) throw new HttpError(404, 'Card not found');
    return cardWithPreview(card);
  }],
  ['POST', /^\/api\/highlights$/, async ({ req }) => {
    const { episodeId, rowId, side, offset, text } = await readJson(req);
    findEpisode(episodeId);
    if (!Number.isInteger(rowId) || !['study', 'en'].includes(side) || !Number.isInteger(offset) || typeof text !== 'string' || !text.trim()) {
      throw new HttpError(400, 'Invalid highlight');
    }
    return store.addHighlight({ episodeId, rowId, side, offset, text });
  }],
  ['DELETE', /^\/api\/highlights\/([\w-]+)$/, ({ match }) => {
    if (!store.deleteHighlight(match[1])) throw new HttpError(404, 'Highlight not found');
    return { ok: true };
  }],
];

async function serveMedia(req, res, id) {
  const episode = findEpisode(id);
  if (!episode.media.length) throw new HttpError(404, "This episode's folder has no video file");
  if (!fs.existsSync(episode.media[0])) throw new HttpError(503, 'The drive with the episodes is not connected');
  sendFileWithRange(req, res, await episodeFile(episode, CACHE_DIR, CACHE_KEEP));
}

function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(PUBLIC, relative);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new HttpError(404, 'Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    // Local-only tool: ignore requests that other websites route here via DNS.
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== 'localhost' && host !== '127.0.0.1') throw new HttpError(403, 'Local access only');

    const url = new URL(req.url, 'http://localhost');
    const media = url.pathname.match(/^\/media\/([\w-]+)\.mp4$/);
    if (media && req.method === 'GET') return await serveMedia(req, res, media[1]);
    if (url.pathname === '/api/cards/export.tsv' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/tab-separated-values; charset=utf-8', 'Content-Disposition': 'attachment; filename="31-palabras-cards.tsv"' });
      return res.end(exportTsv());
    }
    for (const [method, pattern, handler] of routes) {
      const match = url.pathname.match(pattern);
      if (match && method === req.method) return json(res, 200, await handler({ req, url, match }));
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
    throw new HttpError(404, 'Not found');
  } catch (err) {
    if (res.headersSent) return res.destroy();
    if (err instanceof LookupError) return json(res, 502, { error: err.message });
    if (err instanceof HttpError) return json(res, err.status, { error: err.message });
    if (err instanceof MediaProblem) return json(res, 415, { error: err.message });
    console.error(err);
    return json(res, 500, { error: 'Something went wrong on the server' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`31 Palabras: http://localhost:${PORT}`);
  for (const series of library) console.log(`  ${series.title}: ${series.episodes.length} episodes from ${series.root}`);
});
