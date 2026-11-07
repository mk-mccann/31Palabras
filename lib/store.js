// JSON-file persistence for a single local user. Writes go through a rename so
// a crash can't leave a half-written file, and a file that fails to parse stops
// the server rather than being overwritten with an empty one.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { newSchedule, nextSchedule } from './srs.js';
import { invert, remap } from './sync.js';

export const normalizeTerm = (term) => term.trim().toLocaleLowerCase('es');

const VERSION = 2;

// Version 1 knew only one series, in Spanish, and identified episodes as "s1e16".
export function migrate(data) {
  if (data.version >= VERSION) return data;
  const episodeId = (id) => (/^s\d+e\d+$/.test(id) ? `31-minutos--${id}` : id);
  return {
    version: VERSION,
    edits: [],
    cards: data.cards.map(({ contextEs, ...card }) => ({
      ...card,
      lang: 'es',
      contextStudy: contextEs ?? '',
      seriesTitle: '31 Minutos',
      episodeId: episodeId(card.episodeId),
    })),
    highlights: data.highlights.map((highlight) => ({
      ...highlight,
      episodeId: episodeId(highlight.episodeId),
      side: highlight.side === 'es' ? 'study' : highlight.side,
    })),
  };
}

export class Store {
  constructor(dir) {
    this.file = path.join(dir, 'study.json');
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.file)) {
      this.data = { version: VERSION, cards: [], highlights: [], edits: [], sync: {} };
      return;
    }
    const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    this.data = migrate(stored);
    if (this.data !== stored) {
      if (stored.cards.length || stored.highlights.length) {
        fs.copyFileSync(this.file, path.join(dir, `study.v${stored.version ?? 1}.backup.json`));
      }
      this.save();
    }
    this.data.sync ??= {};
  }

  save() {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 1));
    fs.renameSync(temp, this.file);
  }

  listCards() {
    return this.data.cards;
  }

  getCard(id) {
    return this.data.cards.find((c) => c.id === id);
  }

  addCard(fields) {
    const fresh = cardFields(fields);
    // The same spelling in another language ("pan") is a different word.
    const existing = this.data.cards.find((c) => c.lang === fresh.lang && normalizeTerm(c.term) === normalizeTerm(fresh.term));
    if (existing) return { card: existing, duplicate: true };
    const card = { id: randomUUID(), created: Date.now(), ...fresh, ...newSchedule() };
    this.data.cards.push(card);
    this.save();
    return { card, duplicate: false };
  }

  updateCard(id, fields) {
    const card = this.getCard(id);
    if (!card) return null;
    Object.assign(card, cardFields({ ...card, ...fields }));
    this.save();
    return card;
  }

  deleteCard(id) {
    const before = this.data.cards.length;
    this.data.cards = this.data.cards.filter((c) => c.id !== id);
    if (this.data.cards.length !== before) this.save();
    return this.data.cards.length !== before;
  }

  reviewCard(id, grade) {
    const card = this.getCard(id);
    if (!card) return null;
    Object.assign(card, nextSchedule(card, grade));
    this.save();
    return card;
  }

  // Corrections live here rather than in the subtitle files, which stay untouched.
  editsFor(episodeId) {
    return this.data.edits.filter((e) => e.episodeId === episodeId);
  }

  saveEdit({ episodeId, rowId, side, original, text }) {
    this.data.edits = this.data.edits.filter((e) => !(e.episodeId === episodeId && e.rowId === rowId && e.side === side));
    if (text !== original) this.data.edits.push({ episodeId, rowId, side, original, text });
    this.keepHighlightsOnEdit(episodeId, rowId, side, text);
    this.save();
  }

  // A highlight follows its words if they're still in the line, and goes if not.
  keepHighlightsOnEdit(episodeId, rowId, side, text) {
    this.data.highlights = this.data.highlights.filter((hl) => {
      if (hl.episodeId !== episodeId || hl.rowId !== rowId || hl.side !== side) return true;
      if (text.slice(hl.offset, hl.offset + hl.text.length) === hl.text) return true;
      const moved = text.indexOf(hl.text);
      if (moved === -1) return false;
      hl.offset = moved;
      return true;
    });
  }

  syncFor(episodeId) {
    return this.data.sync[episodeId] ?? [];
  }

  // Cards keep the times of the scene they came from, so they move with the sync.
  setSync(episodeId, anchors) {
    const undo = invert(this.syncFor(episodeId));
    for (const card of this.data.cards) {
      if (card.episodeId !== episodeId) continue;
      for (const field of ['start', 'end']) {
        if (card[field] !== null) card[field] = Math.max(0, remap(remap(card[field], undo), anchors));
      }
    }
    if (anchors.length) this.data.sync[episodeId] = anchors;
    else delete this.data.sync[episodeId];
    this.save();
  }

  highlightsFor(episodeId) {
    return this.data.highlights.filter((h) => h.episodeId === episodeId);
  }

  addHighlight({ episodeId, rowId, side, offset, text }) {
    const highlight = { id: randomUUID(), created: Date.now(), episodeId, rowId, side, offset, text };
    this.data.highlights.push(highlight);
    this.save();
    return highlight;
  }

  deleteHighlight(id) {
    const before = this.data.highlights.length;
    this.data.highlights = this.data.highlights.filter((h) => h.id !== id);
    if (this.data.highlights.length !== before) this.save();
    return this.data.highlights.length !== before;
  }
}

// Overlays corrections on an episode's rows. An edit is ignored if the subtitle
// it corrected has since changed, because it may now belong to a different line.
export function applyEdits(rows, edits) {
  const result = rows.map((row) => ({ ...row }));
  for (const edit of edits) {
    const row = result[edit.rowId];
    if (!row || rows[edit.rowId][edit.side] !== edit.original) continue;
    row[edit.side] = edit.text;
    row.original = { ...row.original, [edit.side]: edit.original };
  }
  return result;
}

function cardFields(f) {
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  return {
    lang: text(f.lang) || 'es',
    term: text(f.term),
    meaning: text(f.meaning),
    note: text(f.note),
    contextStudy: text(f.contextStudy),
    contextEn: text(f.contextEn),
    episodeId: text(f.episodeId),
    episodeTitle: text(f.episodeTitle),
    seriesTitle: text(f.seriesTitle),
    start: Number.isFinite(f.start) ? f.start : null,
    end: Number.isFinite(f.end) ? f.end : null,
  };
}
