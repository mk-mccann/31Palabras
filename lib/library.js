// Reads the list of series and finds their episodes on disk. Each episode folder
// holds its media (one file with video and audio, or one of each) and any number
// of subtitle tracks named NAME.<language>.<extension>.

import fs from 'node:fs';
import path from 'node:path';
import { ENGLISH_SUBTITLE_TAGS, LANGUAGES } from './languages.js';
import { mediaDuration } from './media.js';
import { alignCues } from './subs.js';
import { estimateTiming, fallbackDuration, readTrack } from './text-subs.js';

const MIN_CUES_WITH_TEXT = 10; // some tracks are hundreds of blank cues
const MEDIA_EXTENSIONS = new Set(['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.m4a', '.mka', '.opus', '.mp3', '.aac']);
const SUBTITLE_EXTENSIONS = ['.vtt', '.srt', '.txt', '.md', '.rtf'];
const SERIES_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const DEFAULT_SERIES = { id: '31-minutos', title: '31 Minutos', language: 'es' };

export function readSeriesConfig(file, defaultRoot) {
  if (!fs.existsSync(file)) return [{ ...DEFAULT_SERIES, root: defaultRoot }];
  const fail = (message) => { throw new Error(`${file}: ${message}`); };
  let list;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`not valid JSON (${err.message})`);
  }
  if (!Array.isArray(list) || !list.length) fail('expected a list with at least one series');
  const seen = new Set();
  return list.map((entry) => {
    const { id, title, root, language = 'es' } = entry;
    if (typeof id !== 'string' || !SERIES_ID.test(id)) fail(`"id" must be lowercase letters, numbers and single hyphens (got ${JSON.stringify(id)})`);
    if (seen.has(id)) fail(`the id "${id}" is used twice`);
    seen.add(id);
    if (typeof title !== 'string' || !title.trim()) fail(`series "${id}" needs a "title"`);
    if (typeof root !== 'string' || !root.trim()) fail(`series "${id}" needs a "root" folder`);
    if (!LANGUAGES[language]) fail(`series "${id}" has unknown language "${language}"; use one of ${Object.keys(LANGUAGES).join(', ')}`);
    return { id, title, root, language };
  });
}

function pickTrack(dir, files, tags) {
  for (const tag of tags) {
    for (const extension of SUBTITLE_EXTENSIONS) {
      const suffix = `.${tag}${extension}`.toLowerCase();
      const name = files.find((f) => f.toLowerCase().endsWith(suffix));
      if (!name) continue;
      const file = path.join(dir, name);
      if (readTrack(file).cues.length >= MIN_CUES_WITH_TEXT) return file;
    }
  }
  return null;
}

function readEpisode(series, season, folder, dir) {
  const match = folder.match(/^(\d+) - (.+)$/);
  if (!match) return null;
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
  const number = Number(match[1]);
  return {
    id: `${series.id}--s${season}e${String(number).padStart(2, '0')}`,
    seriesId: series.id,
    seriesTitle: series.title,
    language: series.language,
    season,
    number,
    title: match[2].normalize('NFC'),
    media: files.filter((f) => MEDIA_EXTENSIONS.has(path.extname(f).toLowerCase())).map((f) => path.join(dir, f)),
    studyFile: pickTrack(dir, files, LANGUAGES[series.language].subtitleTags),
    enFile: pickTrack(dir, files, ENGLISH_SUBTITLE_TAGS),
  };
}

export function scanSeries(series) {
  if (!fs.existsSync(series.root)) return [];
  const episodes = [];
  for (const entry of fs.readdirSync(series.root).sort()) {
    const seasonMatch = entry.match(/^Season (\d+)$/);
    if (!seasonMatch) continue;
    const seasonDir = path.join(series.root, entry);
    for (const folder of fs.readdirSync(seasonDir).sort()) {
      const dir = path.join(seasonDir, folder);
      if (folder.startsWith('.') || !fs.statSync(dir).isDirectory()) continue;
      const episode = readEpisode(series, Number(seasonMatch[1]), folder, dir);
      if (episode) episodes.push(episode);
    }
  }
  return episodes;
}

export function publicLanguage(code) {
  const { name, nativeName } = LANGUAGES[code];
  return { code, name, nativeName };
}

export function publicEpisode(ep) {
  return {
    id: ep.id,
    seriesId: ep.seriesId,
    seriesTitle: ep.seriesTitle,
    language: publicLanguage(ep.language),
    season: ep.season,
    number: ep.number,
    title: ep.title,
    hasStudy: Boolean(ep.studyFile),
    hasEn: Boolean(ep.enFile),
    playable: ep.media.length > 0,
  };
}

// The span an untimed track is spread over: the other track's, when it has
// timing, or else the whole episode.
async function spanFor(ep, cues, other) {
  if (other.timed && other.cues.length) return [other.cues[0].start, other.cues.at(-1).end];
  const duration = ep.media[0] ? await mediaDuration(ep.media[0]) : null;
  return [0, duration ?? fallbackDuration(cues)];
}

const transcripts = new Map();

export async function transcript(ep) {
  if (transcripts.has(ep.id)) return transcripts.get(ep.id);
  const load = (file) => (file ? readTrack(file) : { cues: [], timed: true });
  const study = load(ep.studyFile);
  const english = load(ep.enFile);
  const timedCues = async (track, other) => {
    if (track.timed) return track.cues;
    const [start, end] = await spanFor(ep, track.cues, other);
    return estimateTiming(track.cues, start, end);
  };
  const result = {
    rows: alignCues(await timedCues(study, english), await timedCues(english, study)),
    estimated: { study: !study.timed, en: !english.timed },
  };
  transcripts.set(ep.id, result);
  return result;
}
