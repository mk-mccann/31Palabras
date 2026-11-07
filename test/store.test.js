import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyEdits, migrate, Store } from '../lib/store.js';

const v1 = {
  cards: [{ id: 'a', term: 'fome', meaning: 'boring', contextEs: 'Qué fome', contextEn: 'So boring', episodeId: 's1e16', episodeTitle: 'Enfermosis', start: 1, end: 2 }],
  highlights: [{ id: 'h', episodeId: 's1e16', rowId: 3, side: 'es', offset: 0, text: 'Qué' }],
};

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), '31-palabras-test-'));

test('migrate moves version 1 data to 31 Minutos without losing anything', () => {
  const { version, cards, highlights, edits } = migrate(v1);
  assert.equal(version, 2);
  assert.deepEqual(edits, []);
  assert.equal(cards[0].episodeId, '31-minutos--s1e16');
  assert.equal(cards[0].contextStudy, 'Qué fome');
  assert.equal(cards[0].contextEs, undefined);
  assert.equal(cards[0].lang, 'es');
  assert.equal(cards[0].seriesTitle, '31 Minutos');
  assert.equal(cards[0].meaning, 'boring');
  assert.equal(highlights[0].episodeId, '31-minutos--s1e16');
  assert.equal(highlights[0].side, 'study');
});

test('Store backs up version 1 data once and leaves it migrated', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'study.json'), JSON.stringify(v1));
  new Store(dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'study.v1.backup.json'), 'utf8')), v1);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'study.json'), 'utf8'));
  assert.equal(onDisk.version, 2);
  fs.rmSync(path.join(dir, 'study.v1.backup.json'));
  new Store(dir);
  assert.equal(fs.existsSync(path.join(dir, 'study.v2.backup.json')), false);
  fs.rmSync(dir, { recursive: true });
});

test('the same spelling in two languages makes two cards', () => {
  const dir = tempDir();
  const store = new Store(dir);
  assert.equal(store.addCard({ term: 'pan', lang: 'es' }).duplicate, false);
  assert.equal(store.addCard({ term: 'Pan', lang: 'es' }).duplicate, true);
  assert.equal(store.addCard({ term: 'pan', lang: 'fr' }).duplicate, false);
  fs.rmSync(dir, { recursive: true });
});

test('edits overlay the transcript and can be restored', () => {
  const dir = tempDir();
  const store = new Store(dir);
  const rows = [{ id: 0, study: 'Hola mundo', en: 'Hi' }];
  store.saveEdit({ episodeId: 'e', rowId: 0, side: 'study', original: 'Hola mundo', text: 'Hola, mundo' });
  const edited = applyEdits(rows, store.editsFor('e'));
  assert.equal(edited[0].study, 'Hola, mundo');
  assert.deepEqual(edited[0].original, { study: 'Hola mundo' });
  assert.equal(rows[0].study, 'Hola mundo');
  store.saveEdit({ episodeId: 'e', rowId: 0, side: 'study', original: 'Hola mundo', text: 'Hola mundo' });
  assert.deepEqual(store.editsFor('e'), []);
  fs.rmSync(dir, { recursive: true });
});

test('an edit is ignored once the subtitle it corrected has changed', () => {
  const edits = [{ episodeId: 'e', rowId: 0, side: 'study', original: 'viejo', text: 'corregido' }];
  assert.equal(applyEdits([{ id: 0, study: 'nuevo', en: '' }], edits)[0].study, 'nuevo');
});

test('highlights follow their words through an edit, and go if the words do', () => {
  const dir = tempDir();
  const store = new Store(dir);
  store.addHighlight({ episodeId: 'e', rowId: 0, side: 'study', offset: 5, text: 'mundo' });
  store.addHighlight({ episodeId: 'e', rowId: 0, side: 'study', offset: 0, text: 'Hola' });
  store.saveEdit({ episodeId: 'e', rowId: 0, side: 'study', original: 'Hola mundo', text: 'Ay, mundo' });
  assert.deepEqual(store.highlightsFor('e').map((h) => [h.text, h.offset]), [['mundo', 4]]);
  fs.rmSync(dir, { recursive: true });
});
