// WebVTT parsing and time-based alignment of two subtitle tracks.

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'" };

export const isSound = (text) => /^[([♪♫].*[)\]♪♫]?$/.test(text) && !/[)\]♪♫].+[([♪♫]/.test(text);

export function joinLines(lines) {
  return lines
    .map((l) => l.replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|nbsp|quot|#39);/g, (e) => ENTITIES[e]).trim())
    .filter(Boolean)
    // Keep line breaks only where a new speaker starts ("- Hola\n- Chao").
    .reduce((out, line) => (out && !line.startsWith('-') ? `${out} ${line}` : out ? `${out}\n${line}` : line), '')
    .replace(/[ \t]+/g, ' ');
}

function seconds(stamp) {
  const parts = stamp.replace(',', '.').split(':').map(Number); // .srt uses a comma
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function parseVtt(source) {
  const cues = [];
  for (const block of source.replace(/^﻿/, '').split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at === -1) continue;
    const match = lines[at].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    if (!match) continue;
    const text = joinLines(lines.slice(at + 1));
    if (!text) continue;
    cues.push({ start: seconds(match[1]), end: seconds(match[2]), text, sound: isSound(text) });
  }
  return cues.sort((a, b) => a.start - b.start);
}

const MAX_GROUP = 3;
const UNMATCHED_PENALTY = 0.4;
const GROUP_PENALTY = 0.05;

function overlap(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function duration(cues, from, count) {
  let total = 0;
  for (let i = from; i < from + count; i++) total += cues[i].end - cues[i].start;
  return total;
}

function groupScore(a, i, k, b, j, l) {
  let shared = 0;
  for (let x = i; x < i + k; x++) for (let y = j; y < j + l; y++) shared += overlap(a[x], b[y]);
  if (shared <= 0) return -Infinity;
  const unmatched = duration(a, i, k) + duration(b, j, l) - 2 * shared;
  return shared - UNMATCHED_PENALTY * unmatched - GROUP_PENALTY * (k + l - 2);
}

function makeRow(a, b) {
  const all = [...a, ...b];
  return {
    start: Math.min(...all.map((c) => c.start)),
    end: Math.max(...all.map((c) => c.end)),
    study: a.map((c) => c.text).join(' '),
    en: b.map((c) => c.text).join(' '),
    sound: all.every((c) => c.sound),
  };
}

// Monotonic DP: walk both tracks in order, pairing small groups of cues (the
// tracks are segmented differently, so 1:2, 3:1 etc. are common) to maximize
// shared on-screen time. A cue with no good partner gets a row of its own.
export function alignCues(study, en) {
  const n = study.length;
  const m = en.length;
  const width = m + 1;
  const best = new Float64Array((n + 1) * width).fill(-Infinity);
  const from = new Int32Array((n + 1) * width); // encoded k * 16 + l
  best[0] = 0;

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const here = best[i * width + j];
      if (here === -Infinity) continue;
      const relax = (k, l, gain) => {
        const to = (i + k) * width + j + l;
        if (here + gain > best[to]) {
          best[to] = here + gain;
          from[to] = k * 16 + l;
        }
      };
      if (i < n) relax(1, 0, 0);
      if (j < m) relax(0, 1, 0);
      for (let k = 1; k <= MAX_GROUP && i + k <= n; k++) {
        for (let l = 1; l <= MAX_GROUP && j + l <= m; l++) {
          const gain = groupScore(study, i, k, en, j, l);
          if (gain > 0) relax(k, l, gain);
        }
      }
    }
  }

  const rows = [];
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const step = from[i * width + j];
    const k = step >> 4;
    const l = step & 15;
    rows.push(makeRow(study.slice(i - k, i), en.slice(j - l, j)));
    i -= k;
    j -= l;
  }
  // Paired rows are already in order, but the DP is free to emit neighboring
  // single-track rows either way round.
  return rows.reverse().sort((a, b) => a.start - b.start).map((row, id) => ({ id, ...row }));
}
