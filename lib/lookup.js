// Dictionary and translation lookups. Linguee answers words and short phrases;
// translate() tries DeepL (with a key), then Google's keyless endpoint, then
// MyMemory. A provider that refuses us is left alone for a while instead of
// being retried on every click.

import * as cheerio from 'cheerio';
import { LANGUAGES } from './languages.js';

const COOLDOWN_MS = 15 * 60_000;
const TIMEOUT_MS = 10_000;
const USER_AGENT = '31-palabras/1.0 (personal study tool)';
const cooldowns = new Map();
const cache = new Map();

export class LookupError extends Error {}

function assertAvailable(provider) {
  const until = cooldowns.get(provider) ?? 0;
  if (Date.now() < until) {
    const minutes = Math.ceil((until - Date.now()) / 60_000);
    throw new LookupError(`${provider} refused an earlier request; trying again in ${minutes} min`);
  }
}

function refuse(provider, status) {
  cooldowns.set(provider, Date.now() + COOLDOWN_MS);
  if (status === 456) return new LookupError(`The ${provider} allowance is used up`);
  return new LookupError(`${provider} refused the request (HTTP ${status})`);
}

async function request(provider, url, init) {
  assertAvailable(provider);
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new LookupError(`${provider} could not be reached (${err.name})`);
  }
  if ([403, 429, 456].includes(res.status)) throw refuse(provider, res.status);
  if (!res.ok && !(init?.allow404 && res.status === 404)) throw new LookupError(`${provider} returned HTTP ${res.status}`);
  return res;
}

async function cached(key, compute) {
  if (cache.has(key)) return cache.get(key);
  const value = await compute();
  cache.set(key, value);
  return value;
}

// Linguee expects queries in Latin-9, so "año" must be sent as a%F1o.
function latin9Query(text) {
  const bytes = { '€': 0xa4, 'Š': 0xa6, 'š': 0xa8, 'Ž': 0xb4, 'ž': 0xb8, 'Œ': 0xbc, 'œ': 0xbd, 'Ÿ': 0xbe };
  let out = '';
  for (const ch of text) {
    const code = bytes[ch] ?? ch.codePointAt(0);
    if (/[A-Za-z0-9._~-]/.test(ch)) out += ch;
    else if (ch === ' ') out += '+';
    else if (code <= 0xff) out += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function parseLinguee(html) {
  const $ = cheerio.load(html);
  const textOf = (el) => $(el).text().replace(/\s+/g, ' ').trim();

  const translationsIn = (scope) => $(scope).find('.translation').toArray().map((node) => {
    const link = $(node).find('.tag_trans .dictLink').first();
    return {
      text: textOf(link),
      type: $(node).find('.tag_trans .tag_type').first().attr('title') ?? '',
      common: !$(node).closest('.translation_group').length,
      examples: $(node).find('.example').toArray().map((ex) => ({
        source: textOf($(ex).find('.tag_s')),
        target: textOf($(ex).find('.tag_t')),
      })),
    };
  }).filter((t) => t.text);

  const entryFrom = (lemma) => ({
    term: textOf($(lemma).find('.tag_lemma .dictLink').first()),
    type: textOf($(lemma).find('.tag_lemma .tag_wordtype').first()),
    translations: translationsIn(lemma),
  });

  return {
    entries: $('.exact .lemma').toArray().map(entryFrom).filter((e) => e.term),
    phrases: $('.example_lines.inexact .lemma').toArray().map(entryFrom).filter((e) => e.term).slice(0, 8),
    sentences: $('#result_table tr').toArray().map((row) => ({
      source: textOf($(row).find('td.left .wrap')),
      target: textOf($(row).find('td.right2 .wrap')),
    })).filter((s) => s.source && s.target).slice(0, 5),
  };
}

export function linguee(query, from, lang) {
  return cached(`linguee:${lang}:${from}:${query}`, async () => {
    const language = LANGUAGES[lang].linguee;
    const source = from === 'en' ? 'english' : language;
    const url = `https://www.linguee.com/english-${language}/search?source=${source}&ajax=1&query=${latin9Query(query)}`;
    const res = await request('Linguee', url);
    const html = new TextDecoder('iso-8859-15').decode(await res.arrayBuffer());
    return { provider: 'Linguee', url: url.replace('&ajax=1', ''), ...parseLinguee(html) };
  });
}

// Linguee has no entry for much Chilean slang (fome, al tiro); Wiktionary does.
export function wiktionary(query, from) {
  return cached(`wiktionary:${from}:${query}`, async () => {
    const lower = query.toLocaleLowerCase(from);
    // German nouns are capitalized, so "Hund" must be tried as written. Elsewhere
    // a capital usually just means the word started a sentence.
    const forms = from === 'de' ? [query, lower] : [lower, query];
    let url;
    for (const form of new Set(forms)) {
      const title = encodeURIComponent(form.replace(/\s+/g, '_'));
      url ??= `https://en.wiktionary.org/wiki/${title}`;
      const res = await request('Wiktionary', `https://en.wiktionary.org/api/rest_v1/page/definition/${title}`, {
        headers: { 'User-Agent': USER_AGENT },
        allow404: true,
      });
      if (res.status === 404) continue;
      const senses = parseWiktionary(await res.json(), from);
      if (senses.length) return { provider: 'Wiktionary', url: `https://en.wiktionary.org/wiki/${title}`, senses };
    }
    return { provider: 'Wiktionary', url, senses: [] };
  });
}

export function parseWiktionary(body, lang) {
  // Sub-senses come twice: nested in the parent's HTML and as their own items.
  const plain = (html) => {
    const $ = cheerio.load(`<div>${html}</div>`);
    $('ol, ul').remove();
    return $.text().replace(/\s+/g, ' ').trim();
  };
  return (body[lang] ?? []).map((section) => ({
    type: section.partOfSpeech,
    definitions: section.definitions.map((d) => plain(d.definition)).filter(Boolean),
  })).filter((s) => s.definitions.length);
}

const PONS = 'https://en.pons.com';
const PONS_MAX_ENTRIES = 8;
const PONS_MAX_TRANSLATIONS = 8;
const PONS_MAX_EXAMPLES = 2;
const PONS_MAX_TRANSLATION_LENGTH = 60; // longer ones are encyclopedia notes
const ponsLanguage = (code) => (code === 'en' ? 'english' : LANGUAGES[code].name.toLowerCase());

const comparable = (term) => term.replace(/\(.*?\)/g, '').replace(/[·|]/g, '').trim().toLocaleLowerCase();

function mergeEntries(entries) {
  const merged = new Map();
  for (const entry of entries) {
    const key = `${comparable(entry.term)}:${entry.type}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, entry);
      continue;
    }
    existing.labels = [...new Set([...existing.labels, ...entry.labels])];
    existing.translations = [...new Set([...existing.translations, ...entry.translations])];
    if (!existing.examples.length) existing.examples = entry.examples;
  }
  return [...merged.values()];
}

export function parsePons(html) {
  const $ = cheerio.load(html);
  const textOf = (el) => $(el).text().replace(/\s+/g, ' ').trim();
  const titles = (scope, cls) => $(scope).find(`.${cls} acronym`).toArray().map((a) => $(a).attr('title')).filter(Boolean);

  const entries = $('.dictionary-hits-container [data-e2e^="dictionary-hit-"]').toArray().map((hit) => {
    const head = $(hit).find('[data-e2e="rom-headword"]').first();
    const label = head.clone();
    label.children().remove(); // leaves the word itself, without its notes and grammar
    const term = textOf(label).replace(/\d+$/, '');
    // A hit can run on into neighboring headwords ("pis" under "aller"), so only
    // rows that belong to this entry's own headword count.
    let current = comparable(term);
    const translations = [];
    const examples = [];
    for (const dl of $(hit).find('dl[data-e2e="translation"]').toArray()) {
      const source = $(dl).find('[data-e2e="translation-source"]');
      const target = textOf($(dl).find('[data-e2e="translation-target"]'));
      const headword = source.find('.headword');
      if (headword.length) current = comparable(textOf(headword));
      if (current !== comparable(term) || !target) continue;
      if (headword.length) {
        if (target.length <= PONS_MAX_TRANSLATION_LENGTH) translations.push(target);
      } else {
        examples.push({ source: textOf(source), target });
      }
    }
    return {
      term,
      type: titles(head, 'wordclass')[0] ?? '',
      labels: [...new Set([...titles(head, 'region'), ...titles(head, 'style')])],
      translations: [...new Set(translations)],
      examples,
    };
  }).filter((e) => e.term && (e.translations.length || e.examples.length));

  const href = $('[data-e2e="see-more-conjugations"]').attr('href');
  const lemma = href ? decodeURIComponent(href.split('/').pop()) : null;
  const primary = Boolean(lemma) && comparable(entries[0]?.term ?? '') === comparable(lemma);
  // "Quiero" leads with the noun "querer" (love), but it's the verb being used.
  const isTheVerb = (entry) => primary && entry.type === 'verb' && comparable(entry.term) === comparable(lemma);
  const ordered = mergeEntries(entries).sort((a, b) => isTheVerb(b) - isTheVerb(a));
  return {
    entries: ordered.slice(0, PONS_MAX_ENTRIES).map((entry) => ({
      ...entry,
      translations: entry.translations.slice(0, PONS_MAX_TRANSLATIONS),
      examples: entry.examples.slice(0, PONS_MAX_EXAMPLES),
    })),
    // PONS offers the tables for "banco" too, because it's also a form of
    // "bancar", so the tables only go up front when the top entry is the verb
    // itself. The entry's type can't decide this: see "quiero" above.
    verb: lemma && { lemma, url: `${PONS}${href}`, primary },
  };
}

export function ponsVerbFor({ entries, verb }, query, from, lang) {
  // Verb tables only help with the language being learned, and a phrase like
  // "al tiro" would bring up the tables for one of its words.
  if (from === 'en' || /\s/.test(query) || !LANGUAGES[lang].ponsVerbTables) return null;
  if (verb) return verb;
  // Some pages, like the one for "es", resolve to a verb without linking its tables.
  const top = entries[0];
  if (top?.type !== 'verb' || /[\s,|]/.test(top.term)) return null;
  return { lemma: top.term, url: `${PONS}/verb-tables/${ponsLanguage(lang)}/${encodeURIComponent(top.term)}`, primary: true };
}

export function pons(query, from, lang) {
  return cached(`pons:${lang}:${from}:${query}`, async () => {
    const to = from === 'en' ? lang : 'en';
    const url = `${PONS}/translate/${ponsLanguage(from)}-${ponsLanguage(to)}/${encodeURIComponent(query)}`;
    const res = await request('PONS', url, { headers: { 'User-Agent': USER_AGENT }, allow404: true });
    const empty = { entries: [], verb: null };
    const parsed = res.status === 404 ? empty : parsePons(await res.text());
    return { provider: 'PONS', url, entries: parsed.entries, verb: ponsVerbFor(parsed, query, from, lang) };
  });
}

export function parsePonsVerb(html) {
  const $ = cheerio.load(html);
  const textOf = (el) => $(el).text().replace(/\s+/g, ' ').trim();
  return $('.conjugation-table').toArray().map((table) => {
    const tense = textOf($(table).find('caption'));
    const group = ($(table).attr('aria-label') ?? '').split(' Conjugation of')[0].replace(tense, '').trim();
    const rows = [];
    let label = '';
    for (const tr of $(table).find('tr').toArray()) {
      const th = $(tr).find('th');
      const heading = textOf(th);
      const form = $(tr).find('td').toArray().filter((td) => !$(td).find('button').length).map(textOf).filter(Boolean).join(' ');
      // Unconjugated forms sit in pairs of rows: "gerundio simple", then "teniendo"
      // or, for compound forms, "habiendo" + "tenido".
      if (!th.find('[data-pons-flection-id]').length && !form) label = heading;
      else if (!form) rows.push({ person: label, form: heading });
      else if (label) rows.push({ person: label, form: `${heading} ${form}` });
      // German imperatives run the other way: "geh(e)" + "(du)".
      else if (/^\(.*\)$/.test(form)) rows.push({ person: form, form: heading });
      else if (heading === 'que') {
        const [pronoun, ...rest] = form.split(' ');
        rows.push({ person: `que ${pronoun}`, form: rest.join(' ') });
      } else rows.push({ person: heading, form });
      if (form || th.find('[data-pons-flection-id]').length) label = '';
    }
    return { group, tense, rows };
  }).filter((table) => table.rows.length);
}

export function ponsVerb(verb, lang) {
  return cached(`pons-verb:${lang}:${verb}`, async () => {
    const url = `${PONS}/verb-tables/${ponsLanguage(lang)}/${encodeURIComponent(verb)}`;
    const res = await request('PONS', url, { headers: { 'User-Agent': USER_AGENT }, allow404: true });
    return { provider: 'PONS', url, verb, tables: res.status === 404 ? [] : parsePonsVerb(await res.text()) };
  });
}

const deeplHost = (key, baseUrl) => baseUrl ?? (key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com');

export async function deeplUsage(key, baseUrl) {
  // Under its own name so that a used-up allowance, which puts "DeepL" on
  // cooldown, can't also hide how much has been used.
  const res = await request('DeepL usage', `${deeplHost(key, baseUrl)}/v2/usage`, {
    headers: { Authorization: `DeepL-Auth-Key ${key}` },
  });
  const body = await res.json();
  return { used: body.character_count, limit: body.character_limit };
}

async function deepl(text, from, to, context, key, baseUrl, saved) {
  const savedKey = JSON.stringify([from, to, context, text]);
  const known = saved?.get(savedKey);
  if (known !== undefined) return { provider: 'DeepL', text: known, senses: [] };
  const host = deeplHost(key, baseUrl);
  const res = await request('DeepL', `${host}/v2/translate`, {
    method: 'POST',
    headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: [text],
      source_lang: from.toUpperCase(),
      target_lang: to === 'en' ? 'EN-US' : LANGUAGES[to].deeplTarget,
      ...(context ? { context } : {}),
    }),
  });
  const body = await res.json();
  const translated = body.translations[0].text;
  saved?.set(savedKey, translated);
  return { provider: 'DeepL', text: translated, senses: [] };
}

async function google(text, from, to) {
  const params = new URLSearchParams({ client: 'gtx', sl: from, tl: to, q: text });
  const res = await request('Google', `https://translate.googleapis.com/translate_a/single?dt=t&dt=bd&${params}`);
  const raw = await res.text();
  // A block page arrives as HTML, sometimes with a 200 status.
  if (raw.trimStart().startsWith('<')) throw refuse('Google', res.status);
  const body = JSON.parse(raw);
  return {
    provider: 'Google',
    text: body[0].map((part) => part[0]).join(''),
    senses: (body[1] ?? []).map(([type, words]) => ({ type, words: words.slice(0, 6) })),
  };
}

async function myMemory(text, from, to) {
  const params = new URLSearchParams({ q: text, langpair: `${from}|${to}` });
  const res = await request('MyMemory', `https://api.mymemory.translated.net/get?${params}`);
  const body = await res.json();
  if (body.quotaFinished || body.responseStatus !== 200) throw refuse('MyMemory', body.responseStatus);
  return { provider: 'MyMemory', text: body.responseData.translatedText, senses: [] };
}

// DeepL's allowance is limited and doesn't renew, so it's never part of an
// automatic lookup: translateWithDeepl only runs when the learner asks for it.
export function translate(text, from, lang) {
  const to = from === 'en' ? lang : 'en';
  return cached(`translate:${from}:${to}:${text}`, async () => {
    const skipped = [];
    for (const provider of [google, myMemory]) {
      try {
        return { ...(await provider(text, from, to)), skipped };
      } catch (err) {
        if (!(err instanceof LookupError)) throw err;
        skipped.push(err.message);
      }
    }
    throw new LookupError(skipped.join('; '));
  });
}

export function translateWithDeepl(text, from, lang, { context = '', key, baseUrl, saved } = {}) {
  const to = from === 'en' ? lang : 'en';
  return cached(`deepl:${from}:${to}:${context}:${text}`, () => deepl(text, from, to, context, key, baseUrl, saved));
}
