import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Store } from '../lib/store.js';
import { addAnchor, invert, remap, syncRows } from '../lib/sync.js';

test('no anchors leaves the timing alone', () => {
  assert.equal(remap(12, []), 12);
});

test('one anchor shifts every line by the same amount', () => {
  const anchors = [{ from: 100, to: 103 }];
  assert.equal(remap(10, anchors), 13);
  assert.equal(remap(100, anchors), 103);
  assert.equal(remap(500, anchors), 503);
});

test('two anchors stretch the timing between them and shift outside', () => {
  const anchors = [{ from: 100, to: 100 }, { from: 200, to: 220 }];
  assert.equal(remap(150, anchors), 160);
  assert.equal(remap(50, anchors), 50);
  assert.equal(remap(300, anchors), 320);
});

test('invert undoes a remap', () => {
  const anchors = [{ from: 100, to: 90 }, { from: 200, to: 230 }];
  assert.equal(remap(remap(150, anchors), invert(anchors)), 150);
});

test('a new anchor replaces any it would cross and keeps them in order', () => {
  const anchors = [{ from: 100, to: 100 }, { from: 200, to: 200 }];
  assert.deepEqual(addAnchor(anchors, { from: 150, to: 160 }).map((a) => a.from), [100, 150, 200]);
  assert.deepEqual(addAnchor(anchors, { from: 150, to: 250 }).map((a) => a.from), [100, 150]);
  assert.deepEqual(addAnchor(anchors, { from: 150, to: 50 }).map((a) => a.from), [150, 200]);
  assert.deepEqual(addAnchor(anchors, { from: 100, to: 120 }), [{ from: 100, to: 120 }, { from: 200, to: 200 }]);
});

test('syncRows moves lines, marks anchored ones, and never goes below zero', () => {
  const rows = [{ id: 0, start: 1, end: 3 }, { id: 1, start: 10, end: 12 }];
  assert.deepEqual(syncRows(rows, [{ from: 10, to: 8 }]), [
    { id: 0, start: 0, end: 1, synced: false },
    { id: 1, start: 8, end: 10, synced: true },
  ]);
});

test('changing the sync moves flashcard clips from that episode only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '31-palabras-test-'));
  const store = new Store(dir);
  store.addCard({ term: 'uno', episodeId: 'e', start: 100, end: 102 });
  store.addCard({ term: 'dos', episodeId: 'otro', start: 100, end: 102 });
  store.addCard({ term: 'tres', episodeId: 'e' });
  store.setSync('e', [{ from: 100, to: 105 }]);
  const times = () => store.listCards().map((c) => [c.term, c.start, c.end]);
  assert.deepEqual(times(), [['uno', 105, 107], ['dos', 100, 102], ['tres', null, null]]);
  // A card made while synced holds synced times, so a later change is relative to them.
  store.setSync('e', [{ from: 100, to: 110 }]);
  assert.deepEqual(times()[0], ['uno', 110, 112]);
  store.setSync('e', []);
  assert.deepEqual(times()[0], ['uno', 100, 102]);
  assert.deepEqual(store.syncFor('e'), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'study.json'), 'utf8')).sync, {});
  fs.rmSync(dir, { recursive: true });
});

test('a data file from before sync existed still loads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '31-palabras-test-'));
  fs.writeFileSync(path.join(dir, 'study.json'), JSON.stringify({ version: 2, cards: [], highlights: [], edits: [] }));
  assert.deepEqual(new Store(dir).syncFor('e'), []);
  fs.rmSync(dir, { recursive: true });
});
