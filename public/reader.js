import { renderLookup } from './lookup-panel.js';
import { api, formatTime, h, normalizeTerm, pref, refreshDueBadge, setPref, termPattern, toast } from './util.js';

const SPEEDS = [1, 0.85, 0.7];
const WORD_CHAR = /[\p{L}\p{N}'’-]/u;
// In French an apostrophe joins two words: clicking "l'homme" should find "homme".
const FRENCH_WORD_CHAR = /[\p{L}\p{N}-]/u;
const PUNCTUATION = /[\s¿?¡!.,;:"“”„‟«»‹›‘’()…–—-]/;
const FOLLOW_PAUSE_MS = 4000;
const CAPTION_LINGER_SECONDS = 0.25;
const TEXT_SCALE = { min: 0.8, max: 1.6, step: 0.1, initial: 1 };
const STAGE_WIDTH = { min: 25, max: 70, step: 5, initial: 38 }; // percent of the window
const clamp = (value, { min, max }) => Math.min(max, Math.max(min, value));

// Paints one transcript cell. Each character gets a set of classes, and runs of
// equal classes become one element, so overlapping marks stay simple.
function paintCell(cell, text, marks) {
  const flags = Array.from({ length: text.length }, () => ({ cls: new Set(), highlightId: null }));
  for (const mark of marks) {
    for (let i = mark.start; i < Math.min(mark.end, text.length); i++) {
      flags[i].cls.add(mark.cls);
      if (mark.highlightId) flags[i].highlightId = mark.highlightId;
    }
  }
  const nodes = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    const key = (f) => [...f.cls].sort().join(' ');
    if (i < text.length && key(flags[i]) === key(flags[start])) continue;
    const piece = text.slice(start, i);
    const cls = key(flags[start]);
    nodes.push(cls ? h('mark', { class: cls, 'data-highlight': flags[start].highlightId }, piece) : piece);
    start = i;
  }
  cell.replaceChildren(...nodes);
}

function offsetInCell(cell, node, offset) {
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.setEnd(node, offset);
  return range.toString().length;
}

function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    return pos && { node: pos.offsetNode, offset: pos.offset };
  }
  const range = document.caretRangeFromPoint?.(x, y);
  return range && { node: range.startContainer, offset: range.startOffset };
}

function wordAround(text, at, wordChar) {
  let start = at;
  let end = at;
  while (start > 0 && wordChar.test(text[start - 1])) start--;
  while (end < text.length && wordChar.test(text[end])) end++;
  return start === end ? null : { start, end };
}

function trimRange(text, start, end) {
  while (start < end && PUNCTUATION.test(text[start])) start++;
  while (end > start && PUNCTUATION.test(text[end - 1])) end--;
  return start === end ? null : { start, end };
}

export async function renderReader(root, id, params) {
  const [episode, initialCards] = await Promise.all([api(`/api/episodes/${id}`), api('/api/cards')]);
  const { rows } = episode;
  const lang = episode.language.code;
  let cards = initialCards;
  let editingRow = null;
  let highlights = episode.highlights;
  let pending = null; // { rowId, side, start, end }
  let activeRow = null;
  let loopRow = null;
  let followPausedUntil = 0;
  let follow = pref('follow', true);
  let hideEnglish = pref('hide-english', false);
  let speedIndex = 0;

  const video = h('video', { controls: true, preload: 'metadata', playsInline: true, src: `/media/${id}.mp4` });
  // The browser's own fullscreen would show only the video, without the subtitles.
  video.setAttribute('controlslist', 'nofullscreen');
  const captionEl = h('div', { class: 'captions' });
  const frame = h('div', { class: 'video-frame' }, video, captionEl);
  const videoNote = h('p', { class: 'video-note', role: 'status' }, 'Preparing the episode…');
  const panel = h('div', { class: 'panel' });
  const cellsById = new Map();
  const rowEls = new Map();
  const timeEls = new Map();
  const syncEls = new Map();

  const transcriptEl = h('section', { class: 'transcript', 'aria-label': 'Transcript' });

  // ---- what's on screen ----

  const studyName = episode.language.name;
  const hasBoth = episode.hasStudy && episode.hasEn;
  const CAPTION_OPTIONS = [
    ['off', 'Off'],
    episode.hasStudy && ['study', studyName],
    episode.hasEn && ['en', 'English'],
    hasBoth && ['both', `${studyName} + English`],
  ].filter(Boolean);
  const TRANSCRIPT_OPTIONS = [
    hasBoth && ['both', `${studyName} + English`],
    episode.hasStudy && ['study', studyName],
    episode.hasEn && ['en', 'English'],
    ['none', 'None'],
  ].filter(Boolean);
  // A saved choice may not exist in this episode, which might have one language.
  const savedChoice = (key, options, fallback) => {
    const saved = pref(key, fallback);
    return options.some(([value]) => value === saved) ? saved : options[0][0];
  };
  let captions = savedChoice('view-captions', CAPTION_OPTIONS, 'off');
  // An episode with no subtitles keeps the column that says so.
  let transcriptView = rows.length ? savedChoice('view-transcript', TRANSCRIPT_OPTIONS, 'both') : 'both';
  let textScale = clamp(pref('text-scale', TEXT_SCALE.initial), TEXT_SCALE);
  let stageWidth = clamp(pref('stage-width', STAGE_WIDTH.initial), STAGE_WIDTH);
  let readerEl = null;

  function applyView() {
    transcriptEl.className = `transcript view-${transcriptView}${hideEnglish ? ' hide-english' : ''}`;
    if (!readerEl) return;
    readerEl.classList.toggle('no-transcript', transcriptView === 'none');
    readerEl.style.setProperty('--stage-width', `${stageWidth}%`);
    readerEl.style.setProperty('--text-scale', textScale);
    drawCaption(true);
  }

  // ---- transcript marks ----

  function marksFor(row, side) {
    const text = row[side];
    const pattern = termPattern(cards.filter((c) => c.lang === lang).map((c) => c.term));
    const marks = [];
    if (side === 'study' && pattern) {
      for (const m of text.matchAll(pattern)) marks.push({ start: m.index, end: m.index + m[0].length, cls: 'known' });
    }
    for (const hl of highlights) {
      if (hl.rowId === row.id && hl.side === side) {
        marks.push({ start: hl.offset, end: hl.offset + hl.text.length, cls: 'highlight', highlightId: hl.id });
      }
    }
    if (pending && pending.rowId === row.id && pending.side === side) {
      marks.push({ start: pending.start, end: pending.end, cls: 'pending' });
    }
    return marks;
  }

  function repaintRow(row) {
    for (const side of ['study', 'en']) {
      const cell = cellsById.get(`${row.id}:${side}`);
      if (!cell) continue;
      const text = row[side];
      cell.classList.toggle('blank', !text);
      if (text) cell.dataset.side = side;
      else delete cell.dataset.side;
      paintCell(cell, text, marksFor(row, side));
    }
    if (row === captionRow) drawCaption(true);
  }

  // ---- subtitles over the video ----

  let captionRow = null;

  // Drawn here rather than with the browser's subtitle track so that they can be
  // clicked for lookups like the transcript, and take the same marks.
  function drawCaption(force = false) {
    const time = video.currentTime;
    const row = activeRow && time >= activeRow.start && time <= activeRow.end + CAPTION_LINGER_SECONDS ? activeRow : null;
    if (row === captionRow && !force) return;
    captionRow = row;
    const sides = captions === 'both' ? ['study', 'en'] : captions === 'off' ? [] : [captions];
    captionEl.replaceChildren(...(row ? sides : []).filter((side) => row[side]).map((side) => {
      const line = h('div', {
        class: `caption-line ${side}`,
        lang: side === 'en' ? 'en' : lang,
        'data-side': side,
        'data-row-id': row.id,
      });
      paintCell(line, row[side], marksFor(row, side));
      return line;
    }));
  }

  const repaintAll = () => rows.forEach(repaintRow);

  // ---- lookup panel ----

  function drawPanel() {
    const selection = pending && {
      ...pending,
      text: rows[pending.rowId][pending.side].slice(pending.start, pending.end),
      row: rows[pending.rowId],
    };
    renderLookup(panel, {
      selection,
      episode,
      highlights,
      cards,
      existingCard: selection && cards.find((c) => c.lang === lang && normalizeTerm(c.term) === normalizeTerm(selection.text)),
      existingHighlight: selection && highlights.find((hl) =>
        hl.rowId === selection.rowId && hl.side === selection.side && hl.offset === selection.start && hl.text === selection.text),
      onHighlight: async () => {
        const created = await api('/api/highlights', {
          method: 'POST',
          body: { episodeId: id, rowId: selection.rowId, side: selection.side, offset: selection.start, text: selection.text },
        });
        highlights = [...highlights, created];
        repaintRow(selection.row);
        drawPanel();
      },
      onRemoveHighlight: async (highlightId) => {
        await api(`/api/highlights/${highlightId}`, { method: 'DELETE' });
        const removed = highlights.find((hl) => hl.id === highlightId);
        highlights = highlights.filter((hl) => hl.id !== highlightId);
        if (removed) repaintRow(rows[removed.rowId]);
        drawPanel();
      },
      onCardSaved: (card) => {
        const known = cards.some((c) => c.id === card.id);
        cards = known ? cards.map((c) => (c.id === card.id ? card : c)) : [...cards, card];
        repaintAll();
        refreshDueBadge();
        toast(known ? 'Card updated' : `Added “${card.term}” to your deck`);
        drawPanel();
      },
      onJump: (rowId) => seekToRow(rows[rowId]),
      onSelectHighlight: (hl) => {
        setPending({ rowId: hl.rowId, side: hl.side, start: hl.offset, end: hl.offset + hl.text.length });
        seekToRow(rows[hl.rowId], { play: false });
      },
    });
  }

  function setPending(next) {
    const previous = pending;
    pending = next;
    if (previous) repaintRow(rows[previous.rowId]);
    if (next) {
      repaintRow(rows[next.rowId]);
      video.pause();
    }
    drawPanel();
  }

  // ---- correcting a line ----

  function stopEditing() {
    if (!editingRow) return;
    const row = editingRow;
    editingRow = null;
    rowEls.get(row.id).classList.remove('editing');
    rowEls.get(row.id).querySelector('.row-edit-actions').remove();
    repaintRow(row);
  }

  async function saveEdit(row, body) {
    try {
      const saved = await api(`/api/episodes/${id}/rows/${row.id}`, { method: 'PUT', body });
      row.study = saved.row.study;
      row.en = saved.row.en;
      row.original = saved.row.original;
      highlights = saved.highlights;
      rowEls.get(row.id).classList.toggle('edited', Boolean(row.original));
      stopEditing();
      drawPanel();
    } catch (err) {
      toast(err.message);
    }
  }

  function startEditing(row) {
    stopEditing();
    video.pause();
    if (pending?.rowId === row.id) setPending(null);
    editingRow = row;
    const rowEl = rowEls.get(row.id);
    rowEl.classList.add('editing');
    const fields = {};
    const collect = () => Object.fromEntries(Object.entries(fields).map(([side, field]) => [side, field.value]));
    for (const side of ['study', 'en']) {
      const cell = cellsById.get(`${row.id}:${side}`);
      if (!cell) continue;
      fields[side] = h('textarea', {
        rows: 2,
        value: row[side],
        lang: side === 'en' ? 'en' : lang,
        'aria-label': side === 'en' ? 'English line' : `${episode.language.name} line`,
        onkeydown: (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            stopEditing();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            saveEdit(row, collect());
          }
        },
      });
      cell.replaceChildren(fields[side]);
    }
    rowEl.append(h('div', { class: 'row-edit-actions' },
      h('button', { type: 'button', class: 'primary', onclick: () => saveEdit(row, collect()) }, 'Save'),
      h('button', { type: 'button', class: 'control', onclick: stopEditing }, 'Cancel'),
      row.original ? h('button', {
        type: 'button',
        class: 'control',
        // Restoring a side means saving its original text, which removes the edit.
        onclick: () => saveEdit(row, row.original),
      }, 'Restore original') : null));
    Object.values(fields)[0]?.focus();
  }

  // ---- correcting the timing ----

  function applySync(result) {
    for (const { id: rowId, start, end, synced } of result.rows) {
      Object.assign(rows[rowId], { start, end, synced });
      timeEls.get(rowId).textContent = formatTime(start);
      syncEls.get(rowId).textContent = synced ? 'Unsync' : 'Sync';
      rowEls.get(rowId).classList.toggle('synced', synced);
    }
    resetSyncButton.hidden = !result.synced;
    tick();
  }

  // Moves this line to where the video is now, and every other line with it.
  async function toggleSync(row) {
    try {
      if (row.synced) {
        applySync(await api(`/api/episodes/${id}/sync?rowId=${row.id}`, { method: 'DELETE' }));
        toast('Released this line');
      } else if (video.readyState === 0) {
        toast('The video has to load before you can sync to it');
      } else {
        const time = video.currentTime;
        applySync(await api(`/api/episodes/${id}/sync`, { method: 'POST', body: { rowId: row.id, time } }));
        toast(`This line now starts at ${formatTime(time)}`);
      }
    } catch (err) {
      toast(err.message);
    }
  }

  async function resetSync() {
    try {
      applySync(await api(`/api/episodes/${id}/sync`, { method: 'DELETE' }));
      toast('Back to the original subtitle timing');
    } catch (err) {
      toast(err.message);
    }
  }

  // ---- selecting text ----

  function onTranscriptMouseUp(event) {
    if (event.target.closest('.time, .row-edit, .row-edit-actions, .editing')) return;
    const cell = event.target.closest('.cell, .caption-line');
    const selection = getSelection();
    if (!cell || !cell.dataset.side) return;
    const rowId = Number(cell.dataset.rowId ?? cell.closest('.row').dataset.id);
    const side = cell.dataset.side;
    const text = rows[rowId][side];
    let range = null;

    if (!selection.isCollapsed && selection.rangeCount) {
      const native = selection.getRangeAt(0);
      if (!cell.contains(native.startContainer) && !cell.contains(native.endContainer)) return;
      // A drag that strays into another line is clipped to the line it touched.
      const start = cell.contains(native.startContainer) ? offsetInCell(cell, native.startContainer, native.startOffset) : 0;
      const end = cell.contains(native.endContainer) ? offsetInCell(cell, native.endContainer, native.endOffset) : text.length;
      range = trimRange(text, start, end);
    } else {
      const caret = caretAt(event.clientX, event.clientY);
      const wordChar = lang === 'fr' && side === 'study' ? FRENCH_WORD_CHAR : WORD_CHAR;
      if (caret && cell.contains(caret.node)) range = wordAround(text, offsetInCell(cell, caret.node, caret.offset), wordChar);
    }
    if (!range) return;
    selection.removeAllRanges();
    // The lookup panel isn't part of fullscreen.
    if (document.fullscreenElement) document.exitFullscreen();
    setPending({ rowId, side, ...range });
  }

  // ---- playback ----

  function seekToRow(row, { play = true } = {}) {
    if (!row) return;
    video.currentTime = row.start;
    markActive(row);
    if (play) video.play().catch(() => {});
  }

  function rowAt(time) {
    let low = 0;
    let high = rows.length - 1;
    let found = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (rows[mid].start <= time) {
        found = rows[mid];
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  function markActive(row) {
    if (row === activeRow) return;
    if (activeRow) rowEls.get(activeRow.id).classList.remove('active');
    activeRow = row;
    if (!row) return;
    const el = rowEls.get(row.id);
    el.classList.add('active');
    if (follow && Date.now() > followPausedUntil) {
      const box = transcriptEl.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      if (rect.top < box.top + box.height * 0.2 || rect.bottom > box.top + box.height * 0.6) {
        // Glide to the next line, but jump after a seek, however far it went.
        const far = rect.top > box.bottom + box.height || rect.bottom < box.top - box.height;
        el.scrollIntoView({ block: 'center', behavior: far ? 'auto' : 'smooth' });
      }
    }
  }

  function tick() {
    const time = video.currentTime;
    if (loopRow && time >= loopRow.end) {
      video.currentTime = loopRow.start;
      return;
    }
    markActive(rowAt(time));
    drawCaption();
  }

  const stepLine = (delta) => {
    const index = activeRow ? activeRow.id : -1;
    seekToRow(rows[Math.min(rows.length - 1, Math.max(0, index + delta))]);
  };

  function toggleLoop() {
    loopRow = loopRow ? null : activeRow ?? rows[0] ?? null;
    loopButton.setAttribute('aria-pressed', Boolean(loopRow));
    if (loopRow) seekToRow(loopRow);
  }

  function toggleEnglish() {
    hideEnglish = !hideEnglish;
    setPref('hide-english', hideEnglish);
    applyView();
    englishButton.setAttribute('aria-pressed', hideEnglish);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else frame.requestFullscreen().catch(() => toast("This browser wouldn't go fullscreen"));
  }

  // Anything that changes the height of the rows loses the place in the transcript.
  const keepPlace = () => {
    if (activeRow) rowEls.get(activeRow.id).scrollIntoView({ block: 'center' });
  };

  function setStageWidth(value, { save = true } = {}) {
    stageWidth = clamp(value, STAGE_WIDTH);
    applyView();
    if (save) {
      setPref('stage-width', stageWidth);
      keepPlace();
    }
  }

  function setTextScale(value) {
    textScale = Math.round(clamp(value, TEXT_SCALE) * 10) / 10;
    setPref('text-scale', textScale);
    textScaleLabel.textContent = `${Math.round(textScale * 100)}%`;
    applyView();
    keepPlace();
  }

  // ---- controls ----

  const control = (label, title, onclick, attrs = {}) => h('button', { type: 'button', class: 'control', title, onclick, ...attrs }, label);
  const loopButton = control('Loop line', 'Repeat the current line (L)', toggleLoop, { 'aria-pressed': 'false' });
  const englishButton = control('Hide English', 'Blur English until you hover over it (E)', toggleEnglish, { 'aria-pressed': String(hideEnglish) });
  const followButton = control('Follow', 'Scroll the transcript with the video', () => {
    follow = !follow;
    setPref('follow', follow);
    followButton.setAttribute('aria-pressed', follow);
  }, { 'aria-pressed': String(follow) });
  const speedButton = control('1×', 'Playback speed', () => {
    speedIndex = (speedIndex + 1) % SPEEDS.length;
    video.playbackRate = SPEEDS[speedIndex];
    speedButton.textContent = `${SPEEDS[speedIndex]}×`;
  });

  const resetSyncButton = control('Reset sync', 'Go back to the original subtitle timing', resetSync, { hidden: !episode.synced });

  const viewSelect = (label, options, value, onchange) => h('label', { class: 'view-row' }, label,
    h('select', {
      onchange: (event) => {
        onchange(event.target.value);
        event.target.blur(); // so the keyboard shortcuts work again
      },
    }, options.map(([optionValue, optionLabel]) => h('option', { value: optionValue, selected: optionValue === value }, optionLabel))));
  const stepper = (label, unit, onStep, valueEl = null) => h('div', { class: 'view-row' }, label,
    h('span', { class: 'stepper' },
      control('−', `Smaller ${unit}`, () => onStep(-1)),
      valueEl,
      control('+', `Bigger ${unit}`, () => onStep(1))));
  const textScaleLabel = h('span', { class: 'stepper-value' }, `${Math.round(textScale * 100)}%`);
  const viewMenu = h('details', { class: 'view-menu' },
    h('summary', { class: 'control' }, 'View'),
    h('div', { class: 'view-popover' },
      rows.length ? viewSelect('Over the video', CAPTION_OPTIONS, captions, (value) => {
        captions = value;
        setPref('view-captions', value);
        applyView();
      }) : null,
      rows.length ? viewSelect('Transcript', TRANSCRIPT_OPTIONS, transcriptView, (value) => {
        transcriptView = value;
        setPref('view-transcript', value);
        applyView();
        keepPlace();
      }) : null,
      stepper('Text size', 'text', (direction) => setTextScale(textScale + direction * TEXT_SCALE.step), textScaleLabel),
      stepper('Video size', 'video', (direction) => setStageWidth(stageWidth + direction * STAGE_WIDTH.step)),
      h('div', { class: 'view-row' }, englishButton, followButton)));

  const controls = h('div', { class: 'controls' },
    control('‹ Line', 'Previous line (←)', () => stepLine(-1)),
    control('Replay', 'Replay this line (R)', () => stepLine(0)),
    control('Line ›', 'Next line (→)', () => stepLine(1)),
    loopButton, speedButton,
    control('Fullscreen', 'Video and subtitles only (F)', toggleFullscreen),
    viewMenu, resetSyncButton);

  const closeViewMenu = (event) => {
    if (viewMenu.open && !viewMenu.contains(event.target)) viewMenu.open = false;
  };
  document.addEventListener('click', closeViewMenu);

  // ---- resizing the video ----

  const splitter = h('div', {
    class: 'splitter',
    role: 'separator',
    tabIndex: 0,
    'aria-orientation': 'vertical',
    'aria-label': 'Resize the video',
    title: 'Drag to resize the video',
    onpointerdown: (event) => {
      splitter.setPointerCapture(event.pointerId);
      splitter.classList.add('dragging');
    },
    onpointermove: (event) => {
      if (!splitter.classList.contains('dragging')) return;
      const box = readerEl.getBoundingClientRect();
      setStageWidth(((event.clientX - box.left) / box.width) * 100, { save: false });
    },
    onpointerup: () => {
      splitter.classList.remove('dragging');
      setStageWidth(stageWidth);
    },
    onkeydown: (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      event.stopPropagation(); // these keys change the line everywhere else
      setStageWidth(stageWidth + (event.key === 'ArrowRight' ? STAGE_WIDTH.step : -STAGE_WIDTH.step));
    },
  });

  // ---- transcript ----

  if (rows.length) {
    transcriptEl.append(h('div', { class: 'row head', 'aria-hidden': 'true' },
      h('span', {}),
      episode.hasStudy ? h('span', { class: 'head-study' }, episode.language.nativeName) : null,
      episode.hasEn ? h('span', { class: 'head-en' }, 'English') : null));
  }
  const estimatedNames = [
    episode.estimated.study ? episode.language.name : null,
    episode.estimated.en ? 'English' : null,
  ].filter(Boolean);
  if (estimatedNames.length) {
    transcriptEl.append(h('p', { class: 'transcript-note' },
      `The ${estimatedNames.join(' and ')} text has no timestamps, so its timing is estimated. Lines won't follow the video exactly and may not pair up correctly. To line them up, pause where a line is spoken and choose Sync on it, at a few points through the episode.`));
  }
  for (const row of rows) {
    const cellFor = (side, cellLang) => {
      const cell = h('div', { class: `cell ${side}`, lang: cellLang });
      cellsById.set(`${row.id}:${side}`, cell);
      return cell;
    };
    timeEls.set(row.id, h('button', { type: 'button', class: 'time', title: 'Play from here', onclick: () => seekToRow(row) }, formatTime(row.start)));
    syncEls.set(row.id, h('button', {
      type: 'button',
      class: 'row-edit row-sync',
      title: 'Make this line start at the current video time, and move the others with it',
      onclick: () => toggleSync(row),
    }, row.synced ? 'Unsync' : 'Sync'));
    const el = h('div', { class: `row${row.sound ? ' sound' : ''}${row.original ? ' edited' : ''}${row.synced ? ' synced' : ''}`, 'data-id': row.id },
      h('div', { class: 'gutter' },
        timeEls.get(row.id),
        h('div', { class: 'row-tools' },
          h('button', { type: 'button', class: 'row-edit', title: 'Correct this line', onclick: () => startEditing(row) }, 'Edit'),
          syncEls.get(row.id))),
      episode.hasStudy ? cellFor('study', lang) : null,
      episode.hasEn ? cellFor('en', 'en') : null);
    rowEls.set(row.id, el);
    transcriptEl.append(el);
  }
  if (!rows.length) {
    transcriptEl.append(h('div', { class: 'empty' },
      h('h2', {}, 'No subtitles for this episode'),
      h('p', {}, 'You can still watch it. To add a transcript, put a subtitle or text file in its folder and restart the app.')));
  }
  repaintAll();
  transcriptEl.addEventListener('mouseup', onTranscriptMouseUp);
  captionEl.addEventListener('mouseup', onTranscriptMouseUp);
  for (const type of ['wheel', 'touchmove']) {
    transcriptEl.addEventListener(type, () => { followPausedUntil = Date.now() + FOLLOW_PAUSE_MS; }, { passive: true });
  }

  // ---- video state ----

  const positionKey = `position-${id}`;
  const requestedTime = Number(params.get('t'));
  video.addEventListener('loadedmetadata', () => {
    videoNote.hidden = true;
    frame.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    const resume = params.has('t') ? requestedTime : pref(positionKey, 0);
    if (resume > 0) video.currentTime = resume;
  });
  video.addEventListener('error', async () => {
    videoNote.hidden = false;
    // The element only reports that it failed, so ask the server why.
    const res = await fetch(`/media/${id}.mp4`, { headers: { Range: 'bytes=0-0' } }).catch(() => null);
    const reason = res && !res.ok ? (await res.json().catch(() => ({}))).error : null;
    videoNote.textContent = reason
      ?? (res ? "This browser can't play this video's format. Chrome and Firefox support the most formats." : "The video couldn't be loaded.");
  });
  video.addEventListener('timeupdate', tick);
  video.addEventListener('seeked', tick);
  const looper = setInterval(() => { if (!video.paused) tick(); }, 100);
  const saver = setInterval(() => { if (!video.paused) setPref(positionKey, video.currentTime); }, 5000);

  function onKey(event) {
    if (event.target.closest?.('input, textarea, select') || event.metaKey || event.ctrlKey || event.altKey) return;
    const actions = {
      ' ': () => (video.paused ? video.play().catch(() => {}) : video.pause()),
      ArrowLeft: () => stepLine(-1),
      ArrowRight: () => stepLine(1),
      r: () => stepLine(0),
      l: toggleLoop,
      e: toggleEnglish,
      f: toggleFullscreen,
      Escape: () => {
        viewMenu.open = false;
        setPending(null);
      },
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  }
  document.addEventListener('keydown', onKey);

  readerEl = h('div', { class: 'reader' },
    h('aside', { class: 'stage' },
      h('div', { class: 'stage-title' },
        h('a', { href: '#/', class: 'back', 'aria-label': 'Back to episodes' }, '‹'),
        h('h1', {}, episode.title),
        h('span', { class: 'stage-sub' }, `${episode.seriesTitle} · S${episode.season} · E${episode.number}`)),
      frame, videoNote, controls, panel),
    splitter,
    transcriptEl);
  root.append(readerEl);
  applyView();
  drawPanel();

  return () => {
    clearInterval(looper);
    clearInterval(saver);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('click', closeViewMenu);
    if (document.fullscreenElement) document.exitFullscreen();
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
}
