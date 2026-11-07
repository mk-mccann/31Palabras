import { api, cardSource, deeplUsageNote, h, refreshDueBadge, toast } from './util.js';

function dueLabel(due) {
  const days = (due - Date.now()) / 86_400_000;
  if (days <= 0) return 'Due now';
  if (days < 0.5) return 'Later today';
  return `In ${Math.ceil(days)} d`;
}

export async function renderDeck(root) {
  let cards = (await api('/api/cards')).sort((a, b) => b.created - a.created);
  const list = h('div', { class: 'deck-list' });
  const search = h('input', { type: 'search', placeholder: 'Search your deck', 'aria-label': 'Search your deck', oninput: draw });

  async function save(card, field, value) {
    try {
      Object.assign(card, await api(`/api/cards/${card.id}`, { method: 'PATCH', body: { [field]: value } }));
    } catch (err) {
      toast(err.message);
    }
  }

  async function remove(card) {
    if (!confirm(`Delete the flashcard “${card.term}”? This can't be undone.`)) return;
    await api(`/api/cards/${card.id}`, { method: 'DELETE' });
    cards = cards.filter((c) => c.id !== card.id);
    refreshDueBadge();
    draw();
  }

  function draw() {
    const needle = search.value.trim().toLocaleLowerCase('es');
    const shown = cards.filter((c) => `${c.term} ${c.meaning} ${c.note}`.toLocaleLowerCase('es').includes(needle));
    if (!cards.length) {
      list.replaceChildren(h('div', { class: 'empty' },
        h('h2', {}, 'No flashcards yet'),
        h('p', {}, 'Click a word in any transcript to look it up and add it here.'),
        h('a', { class: 'button primary', href: '#/' }, 'Choose an episode')));
      return;
    }
    if (!shown.length) {
      list.replaceChildren(h('p', { class: 'muted' }, 'No cards match that search.'));
      return;
    }
    list.replaceChildren(...shown.map((card) => h('article', { class: 'deck-card' },
      h('input', { class: 'deck-term', lang: card.lang, value: card.term, 'aria-label': 'Term', onchange: (e) => save(card, 'term', e.target.value) }),
      h('textarea', { class: 'deck-meaning', rows: 1, value: card.meaning, placeholder: 'Meaning', 'aria-label': 'Meaning', onchange: (e) => save(card, 'meaning', e.target.value) }),
      h('input', { class: 'deck-note', value: card.note, placeholder: 'Note', 'aria-label': 'Note', onchange: (e) => save(card, 'note', e.target.value) }),
      h('div', { class: 'deck-meta muted' },
        card.episodeId ? h('a', { class: 'source-link', href: `#/ep/${card.episodeId}?t=${card.start ?? 0}` }, cardSource(card)) : null,
        h('span', {}, dueLabel(card.due)),
        h('button', { type: 'button', class: 'link-danger', onclick: () => remove(card) }, 'Delete')))));
  }

  draw();
  root.append(h('div', { class: 'deck' },
    h('div', { class: 'library-head' },
      h('h1', {}, `Deck (${cards.length})`),
      h('div', { class: 'deck-tools' },
        search,
        cards.length ? h('a', { class: 'button', href: '/api/cards/export.tsv', download: '' }, 'Export for Anki') : null)),
    h('p', { class: 'provenance' }, deeplUsageNote()),
    list));
}
