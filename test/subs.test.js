import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignCues, parseVtt } from '../lib/subs.js';

const cue = (start, end, text) => ({ start, end, text, sound: false });

test('parseVtt joins wrapped lines, keeps speaker breaks, drops blank cues', () => {
  const cues = parseVtt(`WEBVTT
Kind: captions

00:00:01.000 --> 00:00:02.500
¿Qué tal?, soy Tulio,
y esto es 31 Minutos.

00:00:03.000 --> 00:00:04.000


00:01:00.000 --> 00:01:02.000
- Hola
- Chao &amp; adiós

00:01:03.000 --> 00:01:04.000
(Música de introducción)
`);
  assert.equal(cues.length, 3);
  assert.equal(cues[0].text, '¿Qué tal?, soy Tulio, y esto es 31 Minutos.');
  assert.equal(cues[0].end, 2.5);
  assert.equal(cues[1].text, '- Hola\n- Chao & adiós');
  assert.equal(cues[1].start, 60);
  assert.equal(cues[1].sound, false);
  assert.equal(cues[2].sound, true);
});

test('alignCues pairs one to one with slightly different timing', () => {
  const rows = alignCues([cue(0, 2, 'uno'), cue(3, 5, 'dos')], [cue(0.2, 2.2, 'one'), cue(3.1, 5.1, 'two')]);
  assert.deepEqual(rows.map((r) => [r.study, r.en]), [['uno', 'one'], ['dos', 'two']]);
});

test('alignCues groups a cue that spans two on the other side', () => {
  const rows = alignCues([cue(0, 3, 'uno'), cue(3, 6, 'dos')], [cue(0, 6, 'one two')]);
  assert.deepEqual(rows.map((r) => [r.study, r.en]), [['uno dos', 'one two']]);
});

test('alignCues leaves unmatched cues on their own rows, in order', () => {
  const rows = alignCues([cue(0, 2, 'música'), cue(10, 12, 'hola')], [cue(10, 12, 'hello'), cue(20, 22, 'bye')]);
  assert.deepEqual(rows.map((r) => [r.study, r.en]), [['música', ''], ['hola', 'hello'], ['', 'bye']]);
  assert.deepEqual(rows.map((r) => r.id), [0, 1, 2]);
});

test('alignCues keeps rows in time order when both tracks have unmatched cues', () => {
  const rows = alignCues(
    [cue(6, 10, 'música'), cue(61, 63, 'hola')],
    [cue(50, 52, 'title'), cue(61, 63, 'hello')],
  );
  assert.deepEqual(rows.map((r) => r.start), [6, 50, 61]);
});

test('alignCues handles a single-language episode', () => {
  assert.deepEqual(alignCues([cue(0, 1, 'hola')], []).map((r) => [r.study, r.en]), [['hola', '']]);
  assert.deepEqual(alignCues([], [cue(0, 1, 'hi')]).map((r) => [r.study, r.en]), [['', 'hi']]);
  assert.deepEqual(alignCues([], []), []);
});
