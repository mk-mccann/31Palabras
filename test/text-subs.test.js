import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateTiming, markdownToText, parseTextLines, rtfToText } from '../lib/text-subs.js';
import { parseVtt } from '../lib/subs.js';

test('parseVtt reads .srt blocks with comma timestamps', () => {
  const cues = parseVtt('1\n00:00:01,500 --> 00:00:03,000\nBonjour\n\n2\n00:00:04,000 --> 00:00:05,000\nSalut\n');
  assert.deepEqual(cues.map((c) => [c.start, c.end, c.text]), [[1.5, 3, 'Bonjour'], [4, 5, 'Salut']]);
});

test('parseTextLines reads stamps in common forms, ignoring a title', () => {
  const { cues, timed } = parseTextLines('Episode one\n\n0:05 Hola\n[0:09] - Qué tal\n(1:00:00) Chao\nsigue aquí\n');
  assert.equal(timed, true);
  assert.deepEqual(cues.map((c) => [c.start, c.text]), [[5, 'Hola'], [9, 'Qué tal'], [3600, 'Chao sigue aquí']]);
  assert.equal(cues[0].end, 9);
  assert.equal(cues[1].end, 17); // a long gap doesn't stretch the line across it
});

test('parseTextLines reads a stamp on its own line followed by text', () => {
  const { cues } = parseTextLines('0:05\nHola\n0:09\nQué tal\n0:12\nChao\n');
  assert.deepEqual(cues.map((c) => c.text), ['Hola', 'Qué tal', 'Chao']);
});

test('parseTextLines treats text without stamps as untimed, splitting long paragraphs', () => {
  const long = `${'Esta es una oración bastante larga para la prueba. '.repeat(4)}`;
  const { cues, timed } = parseTextLines(`Hola\n\n${long}`);
  assert.equal(timed, false);
  assert.equal(cues[0].text, 'Hola');
  assert.equal(cues.length, 5);
  assert.equal(cues[0].start, null);
});

test('parseTextLines does not mistake a stray time for timestamps', () => {
  assert.equal(parseTextLines('Hola\n10:30 de la mañana\nChao\n').timed, false);
});

test('estimateTiming fills the span in proportion to length', () => {
  const cues = estimateTiming([{ text: 'a'.repeat(10) }, { text: 'b'.repeat(30) }], 10, 50);
  assert.deepEqual(cues.map((c) => [c.start, c.end]), [[10, 20], [20, 50]]);
});

test('markdownToText strips formatting but keeps speaker dashes', () => {
  const text = markdownToText('---\ntitle: x\n---\n# Heading\n**0:05** Hola *mundo*\n- Sí\n* lista\n> cita\n[enlace](http://x)\n---\nmi_variable _énfasis_\n');
  assert.equal(text.trim(), '0:05 Hola mundo\n- Sí\nlista\ncita\nenlace\nmi_variable énfasis');
});

test('rtfToText handles encodings and drops metadata', () => {
  const rtf = String.raw`{\rtf1\ansi\ansicpg1252\uc1{\fonttbl\f0 Helvetica;}{\colortbl;\red0\green0\blue0;}{\*\expandedcolortbl;;}\f0\fs24 \cf0 Espa\'f1ol\par \u241?and\u245? \{ok\}\
fin}`;
  assert.equal(rtfToText(rtf), 'Español\nñandõ {ok}\nfin');
});
