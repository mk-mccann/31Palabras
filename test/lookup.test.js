import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { deeplUsage, parseLinguee, parsePons, parsePonsVerb, parseWiktionary, ponsVerbFor, translateWithDeepl } from '../lib/lookup.js';

test('translate sends DeepL the expected request, with the line as context', async () => {
  let seen;
  const stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      seen = { path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ translations: [{ text: 'boring' }] }));
    });
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const deeplUrl = `http://127.0.0.1:${stub.address().port}`;
  const result = await translateWithDeepl('qué fome', 'es', 'es', { context: 'Ay, qué fome.', key: 'test-key:fx', baseUrl: deeplUrl });
  stub.close();
  assert.equal(result.provider, 'DeepL');
  assert.equal(result.text, 'boring');
  assert.equal(seen.path, '/v2/translate');
  assert.equal(seen.auth, 'DeepL-Auth-Key test-key:fx');
  assert.deepEqual(seen.body, { text: ['qué fome'], source_lang: 'ES', target_lang: 'EN-US', context: 'Ay, qué fome.' });
});

test('parseWiktionary keeps the right language and drops duplicated sub-senses', () => {
  const senses = parseWiktionary({
    pt: [{ partOfSpeech: 'Noun', definitions: [{ definition: 'hunger' }] }],
    es: [{
      partOfSpeech: 'Verb',
      definitions: [
        { definition: 'inflection of <a href="/x">mover</a>:<ol><li>imperative</li></ol>' },
        { definition: 'imperative' },
        { definition: '' },
      ],
    }],
  }, 'es');
  assert.deepEqual(senses, [{ type: 'Verb', definitions: ['inflection of mover:', 'imperative'] }]);
});

test('parseWiktionary returns nothing when the language is absent', () => {
  assert.deepEqual(parseWiktionary({ pt: [] }, 'es'), []);
});

test('parseLinguee reads entries, translations and examples', () => {
  const result = parseLinguee(`
    <div class='exact'><div class='lemma featured'>
      <span class='tag_lemma'><a class='dictLink'>pelota</a> <span class='tag_wordtype'>noun, feminine</span></span>
      <div class='translation featured'>
        <span class='tag_trans'><a class='dictLink'>ball</a> <span class='tag_type' title='noun'>n</span></span>
        <div class='example'><span class='tag_s'>La pelota.</span><span class='tag_t'>The ball.</span></div>
      </div>
      <div class='translation_group'><div class='translation'>
        <span class='tag_trans'><a class='dictLink'>buck</a></span>
      </div></div>
    </div></div>`);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].term, 'pelota');
  assert.equal(result.entries[0].type, 'noun, feminine');
  assert.deepEqual(result.entries[0].translations.map((t) => [t.text, t.common]), [['ball', true], ['buck', false]]);
  assert.deepEqual(result.entries[0].translations[0].examples, [{ source: 'La pelota.', target: 'The ball.' }]);
});

test('parseLinguee copes with a page that has no results', () => {
  assert.deepEqual(parseLinguee('<html></html>'), { entries: [], phrases: [], sentences: [] });
});

const ponsDl = (source, target) => `<dl data-e2e="translation"><div data-e2e="translation-source">${source}</div><div data-e2e="translation-target">${target}</div></dl>`;
const ponsHit = (id, head, rows) => `<div data-e2e="dictionary-hit-${id}"><span data-e2e="rom-headword">${head}</span>${rows}</div>`;
const ponsPage = (hits, verb = '') => `<div class="dictionary-hits-container">${hits}</div>${verb}`;

test('parsePons keeps clean headwords and usage labels', () => {
  const { entries, verb } = parsePons(ponsPage(ponsHit('a',
    'fome <span class="wordclass"><acronym title="adjective">ADJ</acronym></span> <span class="region"><acronym title="Chile">Chil</acronym></span> <span class="style"><acronym title="informal">inf</acronym></span> <span class="rom-note">A long usage note</span>',
    ponsDl('<strong class="headword">fome</strong>', 'boring') + ponsDl('<span class="example">qué fome</span>', 'how dull'))));
  assert.deepEqual(entries, [{
    term: 'fome', type: 'adjective', labels: ['Chile', 'informal'], translations: ['boring'],
    examples: [{ source: 'qué fome', target: 'how dull' }],
  }]);
  assert.equal(verb, null);
});

test('parsePons drops rows from neighboring headwords and merges repeated entries', () => {
  const verb = '<a data-e2e="see-more-conjugations" href="/verb-tables/french/aller">more</a>';
  const type = '<span class="wordclass"><acronym title="verb">VB</acronym></span>';
  const { entries, verb: found } = parsePons(ponsPage(
    ponsHit('a', `aller ${type}`, ponsDl('<strong class="headword">aller</strong>', 'to go') + ponsDl('<strong class="headword">pis</strong>', 'udder') + ponsDl('<span class="example">il y a pis</span>', "there's worse"))
    + ponsHit('b', `aller ${type}`, ponsDl('<strong class="headword">aller</strong>', 'to leave')),
    verb));
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].translations, ['to go', 'to leave']);
  assert.deepEqual(entries[0].examples, []);
  assert.deepEqual(found, { lemma: 'aller', url: 'https://en.pons.com/verb-tables/french/aller', primary: true });
});

test('parsePons does not treat a noun that is also a verb form as a verb', () => {
  const { verb } = parsePons(ponsPage(
    ponsHit('a', 'banco <span class="wordclass"><acronym title="noun">N</acronym></span>', ponsDl('<strong class="headword">banco</strong>', 'bench')),
    '<a data-e2e="see-more-conjugations" href="/verb-tables/spanish/bancar">more</a>'));
  assert.equal(verb.lemma, 'bancar');
  assert.equal(verb.primary, false);
});

test('parsePons treats a word whose top entry is the verb as a verb, whatever its type', () => {
  const { verb } = parsePons(ponsPage(
    ponsHit('a', 'querer <span class="wordclass"><acronym title="noun">N</acronym></span>', ponsDl('<strong class="headword">querer</strong>', 'love')),
    '<a data-e2e="see-more-conjugations" href="/verb-tables/spanish/querer">more</a>'));
  assert.equal(verb.primary, true);
});

test('parsePons puts the verb above a noun of the same spelling, but not for a noun that is only also a verb form', () => {
  const noun = '<span class="wordclass"><acronym title="noun">N</acronym></span>';
  const vb = '<span class="wordclass"><acronym title="verb">VB</acronym></span>';
  const querer = parsePons(ponsPage(
    ponsHit('a', `querer ${noun}`, ponsDl('<strong class="headword">querer</strong>', 'love'))
    + ponsHit('b', `querer ${vb}`, ponsDl('<strong class="headword">querer</strong>', 'to want')),
    '<a data-e2e="see-more-conjugations" href="/verb-tables/spanish/querer">more</a>'));
  assert.deepEqual(querer.entries.map((e) => e.type), ['verb', 'noun']);
  const banco = parsePons(ponsPage(
    ponsHit('a', `banco ${noun}`, ponsDl('<strong class="headword">banco</strong>', 'bench'))
    + ponsHit('b', `bancar ${vb}`, ponsDl('<strong class="headword">bancar</strong>', 'to put up with')),
    '<a data-e2e="see-more-conjugations" href="/verb-tables/spanish/bancar">more</a>'));
  assert.deepEqual(banco.entries.map((e) => e.term), ['banco', 'bancar']);
});

test('parsePonsVerb reads conjugations and unconjugated forms', () => {
  const button = '<td><button></button></td>';
  const tables = parsePonsVerb(`
    <table class="conjugation-table" aria-label="INDICATIVO presente Conjugation of TENER - Spanish verb | PONS"><caption><span>presente</span></caption>
      <tr><th><span data-pons-flection-id="A">yo</span></th><td><span>tengo</span></td>${button}</tr></table>
    <table class="conjugation-table" aria-label="SUBJUNTIVO subjuntivo imperfecto Conjugation of TENER"><caption>subjuntivo imperfecto</caption>
      <tr><th><span data-pons-flection-id="A">yo</span></th><td><span>tuviera</span> / <span>tuviese</span></td>${button}</tr></table>
    <table class="conjugation-table" aria-label="INDICATIVO perfecto Conjugation of TENER"><caption>perfecto</caption>
      <tr><th><span data-pons-flection-id="A">yo</span></th><td>he</td><td>tenido</td>${button}</tr></table>
    <table class="conjugation-table" aria-label="FORMAS NO PERSONALES  Conjugation of TENER"><tbody>
      <tr><th><span><span>gerundio simple</span></span></th><td></td></tr>
      <tr><th><span data-pons-flection-id="G">teniendo</span></th><td></td></tr>
      <tr><th><span>gerundio compuesto</span></th><td>&nbsp;</td><td></td></tr>
      <tr><th><span data-pons-flection-id="H">habiendo</span></th><td>tenido</td><td></td></tr></tbody></table>
    <table class="conjugation-table" aria-label="Imperativ Conjugation of GEHEN"><tr><th><span data-pons-flection-id="I">geh(e)</span></th><td>(du)</td>${button}</tr></table>
    <table class="conjugation-table" aria-label="Subjonctif Présent Conjugation of ALLER"><caption>Présent</caption><tr><th><span data-pons-flection-id="S">que</span></th><td>j' aille</td>${button}</tr></table>`);
  assert.deepEqual(tables, [
    { group: 'INDICATIVO', tense: 'presente', rows: [{ person: 'yo', form: 'tengo' }] },
    { group: 'SUBJUNTIVO', tense: 'subjuntivo imperfecto', rows: [{ person: 'yo', form: 'tuviera / tuviese' }] },
    { group: 'INDICATIVO', tense: 'perfecto', rows: [{ person: 'yo', form: 'he tenido' }] },
    { group: 'FORMAS NO PERSONALES', tense: '', rows: [{ person: 'gerundio simple', form: 'teniendo' }, { person: 'gerundio compuesto', form: 'habiendo tenido' }] },
    { group: 'Imperativ', tense: '', rows: [{ person: '(du)', form: 'geh(e)' }] },
    { group: 'Subjonctif', tense: 'Présent', rows: [{ person: "que j'", form: 'aille' }] },
  ]);
});

test('ponsVerbFor falls back to the top entry and skips what has no tables', () => {
  const ser = { entries: [{ term: 'ser', type: 'verb' }], verb: null };
  assert.deepEqual(ponsVerbFor(ser, 'es', 'es', 'es'), { lemma: 'ser', url: 'https://en.pons.com/verb-tables/spanish/ser', primary: true });
  assert.equal(ponsVerbFor(ser, 'es', 'pt', 'pt'), null);
  assert.equal(ponsVerbFor(ser, 'is', 'en', 'es'), null);
  assert.equal(ponsVerbFor({ entries: [], verb: { lemma: 'tirar' } }, 'al tiro', 'es', 'es'), null);
  assert.equal(ponsVerbFor({ entries: [{ term: 'pelota', type: 'noun' }], verb: null }, 'pelota', 'es', 'es'), null);
});

function deeplStub() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/v2/usage'
      ? { character_count: 1234, character_limit: 1000000 }
      : { translations: [{ text: 'translated' }] }));
    req.resume();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

test('a saved translation does not call DeepL again', async () => {
  const stub = await deeplStub();
  const saved = new Map([[JSON.stringify(['es', 'en', '', 'ya lo tengo']), 'saved answer']]);
  const result = await translateWithDeepl('ya lo tengo', 'es', 'es', { key: 'k', baseUrl: stub.url, saved });
  assert.equal(result.text, 'saved answer');
  assert.deepEqual(stub.requests, []);
  const fresh = await translateWithDeepl('otra frase', 'es', 'es', { key: 'k', baseUrl: stub.url, saved });
  assert.equal(fresh.text, 'translated');
  assert.equal(saved.get(JSON.stringify(['es', 'en', '', 'otra frase'])), 'translated');
  stub.server.close();
});

test('deeplUsage reads the allowance', async () => {
  const stub = await deeplStub();
  assert.deepEqual(await deeplUsage('k', stub.url), { used: 1234, limit: 1000000 });
  stub.server.close();
});
