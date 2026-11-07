import { api, deeplUsageNote, formatTime, h, toast } from './util.js';

const DICTIONARY_MAX_WORDS = 5;
const PONS_SHOWN_ENTRIES = 3;
const VERB_PREVIEW_TABLES = 4;
const VERB_MAX_NAMED = 3;
const FALLBACK_ORDER = ['pons', 'wiktionary', 'translate']; // never DeepL, which costs
let requestToken = 0;
let form = null;
let source = null;

function fill(token, target, promise, render) {
  promise
    .then((result) => {
      if (token === requestToken) target.replaceChildren(...render(result).flat().filter(Boolean));
    })
    .catch((err) => {
      if (token === requestToken) target.replaceChildren(h('p', { class: 'muted' }, err.message));
    });
}

function drawProvenance(result) {
  return h('p', { class: 'provenance' }, `Machine translation by ${result.provider}`,
    result.provider === 'DeepL' ? [' · ', deeplUsageNote()] : null);
}

// Spends the DeepL allowance, so it only runs when asked, and says what it costs.
function drawDeeplOption({ token, text, params, context = '', useResult }) {
  const slot = h('div', { class: 'deepl-option' });
  const ask = () => {
    slot.replaceChildren(h('p', { class: 'muted' }, 'Asking DeepL…'));
    fill(token, slot, api(`/api/lookup/deepl?q=${encodeURIComponent(text)}&${params}&context=${encodeURIComponent(context)}`), (r) => [
      useResult
        ? h('button', { type: 'button', class: 'translation-main', title: 'Use as the meaning', onclick: () => useResult(r.text) }, r.text)
        : h('p', {}, r.text),
      drawProvenance(r),
    ]);
  };
  slot.append(h('button', {
    type: 'button',
    class: 'control',
    title: 'Translate with DeepL, using your limited allowance',
    onclick: ask,
  }, `Ask DeepL (${text.length.toLocaleString()} characters)`));
  return slot;
}

function drawTranslation(result, useMeaning) {
  return [
    h('button', { type: 'button', class: 'translation-main', title: 'Use as the meaning', onclick: () => useMeaning(result.text) }, result.text),
    result.senses.map((sense) => h('p', { class: 'sense' },
      h('span', { class: 'pos' }, sense.type),
      sense.words.map((word) => h('button', { type: 'button', class: 'chip', onclick: () => useMeaning(word) }, word)))),
    drawProvenance(result),
  ];
}

function drawWiktionary(result, useMeaning) {
  if (!result.senses.length) return [h('p', { class: 'muted' }, 'No entry for this form. Try the base form of the word, or another source.')];
  return result.senses.map((sense) => h('div', { class: 'sense-block' },
    h('span', { class: 'pos' }, sense.type),
    h('ol', {}, sense.definitions.slice(0, 5).map((definition) =>
      h('li', {}, h('button', { type: 'button', class: 'definition', title: 'Use as the meaning', onclick: () => useMeaning(definition) }, definition))))));
}

function drawLinguee(result, useMeaning, lang) {
  const { entries, phrases, sentences } = result;
  if (!entries.length && !phrases.length && !sentences.length) return [h('p', { class: 'muted' }, 'No results. Try another source.')];
  const chips = (translations) => translations.slice(0, 8).map((t) =>
    h('button', { type: 'button', class: `chip${t.common ? ' strong' : ''}`, title: t.type, onclick: () => useMeaning(t.text) }, t.text));
  return [
    entries.map((entry) => h('div', { class: 'sense-block' },
      h('p', { class: 'entry-head' }, h('strong', { lang }, entry.term), entry.type ? h('span', { class: 'pos' }, entry.type) : null),
      h('p', { class: 'sense' }, chips(entry.translations)),
      entry.translations.flatMap((t) => t.examples).slice(0, 2).map((ex) =>
        h('p', { class: 'example' }, h('span', { lang }, ex.source), h('span', { class: 'muted' }, ex.target))))),
    phrases.length ? h('details', {},
      h('summary', {}, `Phrases (${phrases.length})`),
      phrases.map((entry) => h('p', { class: 'sense' }, h('strong', { lang }, entry.term), ' ', chips(entry.translations)))) : null,
    sentences.length ? h('details', {},
      h('summary', {}, `In other texts (${sentences.length})`),
      sentences.map((s) => h('p', { class: 'example' }, h('span', { lang }, s.source), h('span', { class: 'muted' }, s.target)))) : null,
  ];
}

function drawPonsEntry(entry, useMeaning, lang) {
  return h('div', { class: 'sense-block' },
    h('p', { class: 'entry-head' },
      h('strong', { lang }, entry.term),
      entry.type ? h('span', { class: 'pos' }, entry.type) : null,
      entry.labels.map((label) => h('span', { class: 'usage-label' }, label))),
    entry.translations.length ? h('p', { class: 'sense' }, entry.translations.map((text) =>
      h('button', { type: 'button', class: 'chip', onclick: () => useMeaning(text) }, text))) : null,
    entry.examples.map((ex) => h('p', { class: 'example' }, h('span', { lang }, ex.source), h('span', { class: 'muted' }, ex.target))));
}

const formWords = (form) => form.toLocaleLowerCase().split(/[\s/]+/).map((word) => word.replace(/[()]/g, ''));

// "Présent" needs its mood to be clear, but "subjuntivo presente" already has it.
function tenseName({ group, tense }) {
  const mood = group.toLocaleLowerCase();
  if (!tense) return mood;
  return tense.toLocaleLowerCase().includes(mood) ? tense : `${mood} · ${tense}`;
}

function drawVerbTable(table, query, lang) {
  return h('table', { class: 'verb-table' },
    h('caption', {}, tenseName(table)),
    h('tbody', {}, table.rows.map((row) => h('tr', { class: formWords(row.form).includes(query) ? 'matched' : null },
      h('th', { scope: 'row' }, row.person),
      h('td', { lang }, row.form)))));
}

function drawVerb(result, query, lang) {
  const { tables } = result;
  if (!tables.length) return [h('p', { class: 'muted' }, 'PONS has no verb table for this word.')];
  const wanted = query.toLocaleLowerCase();
  const hasForm = (table) => table.rows.some((row) => formWords(row.form).includes(wanted));
  const matches = tables.filter(hasForm);
  const personal = tables.filter((table) => table.tense && table.rows.length > 2);
  const preview = [...new Set([...matches, ...personal])].slice(0, VERB_PREVIEW_TABLES);
  const named = matches.map((table) => {
    const persons = table.rows.filter((row) => formWords(row.form).includes(wanted)).map((row) => row.person.replace(/[()]/g, ''));
    return `${tenseName(table)}${persons.some(Boolean) ? `: ${persons.join(', ')}` : ''}`;
  });
  const groups = [...new Set(tables.map((table) => table.group))];
  return [
    named.length ? h('p', { class: 'verb-form' }, h('strong', { lang }, query), ` is ${named.slice(0, VERB_MAX_NAMED).join('; ')}`) : null,
    h('div', { class: 'verb-tables' }, preview.map((table) => drawVerbTable(table, wanted, lang))),
    h('details', {},
      h('summary', {}, `All tenses (${tables.length})`),
      groups.map((group) => h('div', { class: 'verb-tables' }, tables.filter((table) => table.group === group).map((table) => drawVerbTable(table, wanted, lang))))),
  ];
}

function drawVerbBlock(token, verb, query, lang) {
  const body = h('div', { class: 'source-body' }, h('p', { class: 'muted' }, 'Loading verb table…'));
  const load = () => fill(token, body, api(`/api/lookup/pons-verb?q=${encodeURIComponent(verb.lemma)}&lang=${lang}`), (r) => drawVerb(r, query, lang));
  const link = h('a', { href: verb.url, target: '_blank', rel: 'noopener noreferrer', class: 'source-link' }, 'full tables ↗');
  if (verb.primary) {
    load();
    return h('div', { class: 'verb-block' }, h('h4', {}, h('span', {}, 'Verb: ', h('span', { lang }, verb.lemma)), link), body);
  }
  // A noun that happens to be a verb form too shouldn't fetch or show its table
  // until asked.
  const details = h('details', { class: 'verb-block', ontoggle: (event) => { if (event.target.open) load(); } },
    h('summary', {}, `Also a form of the verb ${verb.lemma}`),
    link,
    body);
  return details;
}

function drawPons(result, useMeaning, lang, query, token) {
  const shown = result.entries.slice(0, PONS_SHOWN_ENTRIES);
  const more = result.entries.slice(PONS_SHOWN_ENTRIES);
  return [
    result.entries.length ? null : h('p', { class: 'muted' }, 'No entry for this form. Try the base form of the word, or another source.'),
    shown.map((entry) => drawPonsEntry(entry, useMeaning, lang)),
    more.length ? h('details', {}, h('summary', {}, `More entries (${more.length})`), more.map((entry) => drawPonsEntry(entry, useMeaning, lang))) : null,
    result.verb ? drawVerbBlock(token, result.verb, query, lang) : null,
  ];
}

function drawHighlights(state) {
  const { highlights, episode } = state;
  const items = [...highlights].sort((a, b) => a.rowId - b.rowId);
  const rows = episode.rows;
  return h('div', { class: 'highlight-list' },
    h('h2', {}, `Highlights (${items.length})`),
    items.length
      ? h('ul', {}, items.map((hl) => h('li', {},
        h('button', { type: 'button', class: 'highlight-link', onclick: () => state.onSelectHighlight(hl) },
          h('mark', { class: 'highlight' }, hl.text),
          h('span', { class: 'muted' }, formatTime(rows[hl.rowId]?.start ?? 0))))))
      : h('p', { class: 'muted' }, 'Click a word or drag across a phrase in the transcript or subtitles to look it up.'));
}

function drawCardForm(state, selection, fields) {
  const { existingCard } = state;
  const saving = async (event) => {
    event.preventDefault();
    const body = {
      term: fields.term.value,
      meaning: fields.meaning.value,
      note: fields.note.value,
      lang: state.episode.language.code,
      contextStudy: selection.row.study,
      contextEn: selection.row.en,
      episodeId: state.episode.id,
      episodeTitle: state.episode.title,
      seriesTitle: state.episode.seriesTitle,
      start: selection.row.start,
      end: selection.row.end,
    };
    try {
      if (existingCard) {
        // Keep the card's original scene; only the text the learner typed changes.
        const card = await api(`/api/cards/${existingCard.id}`, {
          method: 'PATCH',
          body: { term: body.term, meaning: body.meaning, note: body.note },
        });
        state.onCardSaved(card);
      } else {
        const { card } = await api('/api/cards', { method: 'POST', body });
        state.onCardSaved(card);
      }
    } catch (err) {
      toast(err.message);
    }
  };
  return h('form', { class: 'card-form', onsubmit: saving },
    h('label', {}, 'Term', fields.term),
    h('label', {}, 'Meaning', fields.meaning),
    h('label', {}, 'Note', fields.note),
    h('button', { type: 'submit', class: 'primary' }, existingCard ? 'Update card' : 'Add to deck'));
}

export function renderLookup(panel, state) {
  const { selection } = state;
  const token = ++requestToken;
  if (!selection) {
    form = null;
    panel.replaceChildren(drawHighlights(state));
    return;
  }

  const fromStudy = selection.side === 'study';
  const lang = state.episode.language.code;
  const from = fromStudy ? lang : 'en';
  const { existingCard, existingHighlight } = state;
  // The panel also redraws when a highlight changes; keep what's been typed.
  const selectionKey = `${selection.rowId}:${selection.side}:${selection.start}:${selection.end}`;
  const kept = form?.key === selectionKey ? form.fields : null;
  const initial = (field, fallback) => kept?.[field].value ?? fallback;
  const fields = {
    term: h('input', { required: true, lang, value: initial('term', existingCard?.term ?? (fromStudy ? selection.text : '')) }),
    meaning: h('textarea', { rows: 1, value: initial('meaning', existingCard?.meaning ?? (fromStudy ? '' : selection.text)) }),
    note: h('input', { value: initial('note', existingCard?.note ?? ''), placeholder: 'e.g. slang, said to friends' }),
  };
  form = { key: selectionKey, fields };
  // Results always fill the side of the card being learned: picking a result for
  // an English selection supplies the term instead of the meaning.
  const useMeaning = (text) => {
    if (!fromStudy) {
      fields.term.value = text;
      return;
    }
    const current = fields.meaning.value.trim();
    const parts = current ? current.split(/;\s*/) : [];
    if (!parts.includes(text)) fields.meaning.value = [...parts, text].join('; ');
  };

  const lineText = selection.row[selection.side];
  const params = `from=${from}&lang=${lang}`;
  const query = encodeURIComponent(selection.text);
  const words = selection.text.trim().split(/\s+/).length;
  const hasDictionaries = words <= DICTIONARY_MAX_WORDS;
  const SOURCES = [
    hasDictionaries && {
      id: 'pons',
      label: 'PONS',
      path: `/api/lookup/pons?q=${query}&${params}`,
      draw: (r) => drawPons(r, useMeaning, from, selection.text, token),
      isEmpty: (r) => !r.entries.length && !r.verb,
    },
    {
      id: 'translate',
      label: 'Google Translate',
      path: `/api/lookup/translate?q=${query}&${params}`,
      draw: (r) => drawTranslation(r, useMeaning),
    },
    hasDictionaries && {
      id: 'wiktionary',
      label: 'Wiktionary',
      path: `/api/lookup/wiktionary?q=${query}&${params}`,
      draw: (r) => drawWiktionary(r, useMeaning),
      isEmpty: (r) => !r.senses.length,
    },
    hasDictionaries && {
      id: 'linguee',
      label: 'Linguee',
      path: `/api/lookup/linguee?q=${query}&${params}`,
      draw: (r) => drawLinguee(r, useMeaning, from),
    },
    state.episode.deepl && { id: 'deepl', label: 'DeepL' },
  ].filter(Boolean);

  // A dictionary answers a single word best; a phrase needs translating. The
  // choice lasts as long as the selection, including redraws from highlighting.
  if (source?.key !== selectionKey) {
    source = { key: selectionKey, id: words === 1 ? 'pons' : 'translate', automatic: words === 1, tried: [] };
  }

  const select = h('select', {
    // Blur so the keyboard shortcuts work again right after choosing.
    onchange: (event) => {
      Object.assign(source, { automatic: false, tried: [] });
      showSource(event.target.value);
      event.target.blur();
    },
  }, SOURCES.map((option) => h('option', { value: option.id, selected: option.id === source.id }, option.label)));
  const sourceLink = h('span', {});
  const sourceBody = h('div', {});

  function showSource(id) {
    source.id = id;
    select.value = id;
    const chosen = SOURCES.find((option) => option.id === id);
    // Each source gets a new container, so a slow answer from the last one lands
    // somewhere no longer on the page.
    const body = h('div', { class: 'source-body' });
    const link = h('span', {});
    sourceBody.replaceChildren(body);
    sourceLink.replaceChildren(link);
    if (id === 'deepl') {
      // Not automatic: moving through the list must not spend the allowance.
      body.append(drawDeeplOption({ token, text: selection.text, params, context: lineText, useResult: useMeaning }));
      return;
    }
    body.append(h('p', { class: 'muted' }, 'Looking up…'));

    // Only the first automatic lookup moves on; a source picked by hand stays put.
    const next = source.automatic ? FALLBACK_ORDER[FALLBACK_ORDER.indexOf(id) + 1] : null;
    const isCurrent = () => token === requestToken && sourceBody.firstChild === body;
    const moveOn = () => {
      source.tried.push(chosen.label);
      showSource(next);
    };
    const answer = api(chosen.path).catch((err) => {
      if (next && isCurrent()) moveOn();
      throw err;
    });
    fill(token, body, answer, (r) => {
      if (next && isCurrent() && chosen.isEmpty?.(r)) {
        moveOn();
        return [];
      }
      if (r.url) link.replaceChildren(h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer', class: 'source-link' }, 'open ↗'));
      const note = source.tried.length
        ? h('p', { class: 'source-note' }, `Nothing from ${source.tried.join(' or ')}, so this is ${chosen.label}.`)
        : null;
      return [note, ...chosen.draw(r)];
    });
  }

  const sourcePicker = h('section', { class: 'source' },
    h('div', { class: 'source-head' }, h('label', {}, 'Source ', select), sourceLink),
    sourceBody);
  showSource(source.id);

  const lineTranslation = h('div', { class: 'line-translation' });
  const translateLine = () => {
    lineTranslation.replaceChildren(h('p', { class: 'muted' }, 'Translating…'));
    fill(token, lineTranslation, api(`/api/lookup/translate?q=${encodeURIComponent(lineText)}&${params}`), (r) => [
      h('p', {}, r.text),
      drawProvenance(r),
      state.episode.deepl ? drawDeeplOption({ token, text: lineText, params }) : null,
    ]);
  };

  panel.replaceChildren(h('div', { class: 'lookup', 'aria-live': 'polite' },
    h('header', { class: 'lookup-head' },
      h('h2', { lang: from }, selection.text),
      h('div', { class: 'lookup-actions' },
        existingHighlight
          ? h('button', { type: 'button', class: 'control', 'aria-pressed': 'true', onclick: () => state.onRemoveHighlight(existingHighlight.id) }, 'Highlighted')
          : h('button', { type: 'button', class: 'control', onclick: state.onHighlight }, 'Highlight'),
        h('button', { type: 'button', class: 'control', onclick: translateLine, title: 'Machine-translate the whole line' }, 'Translate line'))),
    lineTranslation,
    sourcePicker,
    drawCardForm(state, selection, fields)));
}
