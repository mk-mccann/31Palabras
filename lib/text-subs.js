// Reads subtitle tracks in any supported format. .vtt and .srt carry their own
// timing; .txt, .md and .rtf may have timestamps at the start of lines, or none,
// in which case the caller has to estimate where the lines fall.

import fs from 'node:fs';
import path from 'node:path';
import { isSound, joinLines, parseVtt } from './subs.js';

const STAMP = /^\s*[[(]?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)[\])]?\s*(?:[-–—:|]\s*)?(.*)$/;
const MIN_STAMPS = 3;
const LONG_LINE = 120;
const MIN_SENTENCE = 25;
const LAST_CUE_SECONDS = 4;
const MAX_CUE_SECONDS = 8;
const FALLBACK_CHARS_PER_SECOND = 15;

const RTF_DESTINATIONS = new Set(['fonttbl', 'colortbl', 'expandedcolortbl', 'stylesheet', 'info', 'pict', 'header', 'footer',
  'headerl', 'headerr', 'footerl', 'footerr', 'listtable', 'listoverridetable', 'generator', 'object', 'themedata', 'datastore']);
const RTF_SYMBOLS = { par: '\n', line: '\n', sect: '\n', page: '\n', row: '\n', tab: '\t', emdash: '—', endash: '–',
  lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', bullet: '•' };

export function rtfToText(source) {
  const decoder = new TextDecoder('windows-1252');
  const stack = [{ skip: false, uc: 1 }];
  let state = stack[0];
  let out = '';
  let i = 0;
  const emit = (text) => { if (!state.skip) out += text; };
  // After \uN, the writer leaves a fallback for old readers; it must be dropped.
  const skipFallback = () => {
    for (let left = state.uc; left > 0 && i < source.length; left--) {
      if (source[i] === '\\' && source[i + 1] === "'") i += 4;
      else i++;
    }
  };

  while (i < source.length) {
    const ch = source[i];
    if (ch === '{') {
      state = { ...state };
      stack.push(state);
      i++;
      if (source.startsWith('\\*', i)) {
        state.skip = true;
        i += 2;
      }
    } else if (ch === '}') {
      if (stack.length > 1) stack.pop();
      state = stack.at(-1);
      i++;
    } else if (ch === '\\') {
      const next = source[i + 1];
      if (next === "'") {
        emit(decoder.decode(Uint8Array.of(parseInt(source.slice(i + 2, i + 4), 16))));
        i += 4;
      } else if (next === '\n' || next === '\r') {
        emit('\n');
        i += 2;
      } else if (/[a-zA-Z]/.test(next ?? '')) {
        const match = source.slice(i + 1, i + 40).match(/^([a-zA-Z]+)(-?\d+)? ?/);
        i += 1 + match[0].length;
        const [, word, arg] = match;
        if (RTF_DESTINATIONS.has(word)) state.skip = true;
        else if (word === 'uc') state.uc = Number(arg);
        else if (word === 'u') {
          emit(String.fromCharCode(Number(arg) < 0 ? Number(arg) + 65536 : Number(arg)));
          skipFallback();
        } else if (RTF_SYMBOLS[word]) emit(RTF_SYMBOLS[word]);
      } else {
        if (next === '~') emit(' ');
        else if (next === '\\' || next === '{' || next === '}') emit(next);
        i += 2;
      }
    } else {
      if (ch !== '\n' && ch !== '\r') emit(ch);
      i++;
    }
  }
  return out;
}

export function markdownToText(source) {
  return source
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s{0,3}#{1,6}\s/.test(line) && !/^\s*([-*_])\1{2,}\s*$/.test(line) && !/^\s*```/.test(line))
    .map((line) => line
      .replace(/^\s*>\s?/, '')
      // "- " stays: in subtitles it marks a change of speaker.
      .replace(/^\s*[*+]\s+/, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/(^|[^\p{L}\p{N}])__?(.+?)__?(?=[^\p{L}\p{N}]|$)/gu, '$1$2')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\\([\\*_#`[\]-])/g, '$1'))
    .join('\n');
}

function stampSeconds(stamp) {
  return stamp.replace(',', '.').split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
}

function splitLongLine(line) {
  if (line.length <= LONG_LINE) return [line];
  const pieces = line.match(/[^.!?…]+[.!?…]*["”»)]*\s*/g) ?? [line];
  const sentences = [];
  for (const piece of pieces) {
    // Keep fragments such as "Sr." attached to the sentence they start.
    if (sentences.length && sentences.at(-1).length < MIN_SENTENCE) sentences[sentences.length - 1] += piece;
    else sentences.push(piece);
  }
  return sentences.map((s) => s.trim()).filter(Boolean);
}

// Returns timed cues when the text has timestamps; otherwise cues with null times.
export function parseTextLines(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const stamped = lines.filter((l) => STAMP.test(l)).length;
  if (stamped < MIN_STAMPS) {
    const cues = lines.flatMap(splitLongLine).map((line) => ({ start: null, end: null, text: line, sound: isSound(line) }));
    return { cues, timed: false };
  }

  const groups = [];
  for (const line of lines) {
    const match = line.match(STAMP);
    if (match) groups.push({ start: stampSeconds(match[1]), lines: match[2] ? [match[2]] : [] });
    else groups.at(-1)?.lines.push(line); // text before the first stamp is a title
  }
  const timed = groups.filter((g) => g.lines.length).sort((a, b) => a.start - b.start);
  const cues = timed.map((group, i) => {
    const next = timed[i + 1]?.start;
    const body = joinLines(group.lines);
    return {
      start: group.start,
      end: next === undefined ? group.start + LAST_CUE_SECONDS : Math.min(next, group.start + MAX_CUE_SECONDS),
      text: body,
      sound: isSound(body),
    };
  });
  return { cues, timed: true };
}

// Spreads untimed lines across a span in proportion to their length.
export function estimateTiming(cues, start, end) {
  const weights = cues.map((c) => Math.max(c.text.length, 10));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const perUnit = (end - start) / total;
  let at = start;
  return cues.map((cue, i) => {
    const cueStart = at;
    at += weights[i] * perUnit;
    return { ...cue, start: cueStart, end: at };
  });
}

export const fallbackDuration = (cues) => cues.reduce((sum, c) => sum + c.text.length, 0) / FALLBACK_CHARS_PER_SECOND;

// Files saved by word processors aren't always UTF-8.
function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer);
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

export function readTrack(file) {
  const extension = path.extname(file).toLowerCase();
  let text = decodeText(fs.readFileSync(file));
  if (extension === '.rtf') text = rtfToText(text);
  if (extension === '.md') text = markdownToText(text);
  // Pasted .srt or .vtt content counts as timed, whatever the file is called.
  if (text.includes('-->')) return { cues: parseVtt(text), timed: true };
  return parseTextLines(text);
}
