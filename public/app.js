import { renderDeck } from './deck.js';
import { renderReader } from './reader.js';
import { renderReview } from './review.js';
import { api, h, pref, refreshDueBadge, setPref } from './util.js';

const view = document.getElementById('view');
let cleanup = null;

function subtitleLabel(ep) {
  const { name } = ep.language;
  if (ep.hasStudy && ep.hasEn) return [`${name} + English`, 'both'];
  if (ep.hasStudy) return [`${name} only`, 'one'];
  if (ep.hasEn) return ['English only', 'one'];
  return ['No subtitles', 'none'];
}

function renderSeries(series) {
  if (!series.available) {
    return h('div', { class: 'empty' },
      h('h2', {}, `Can't find ${series.title}`),
      h('p', {}, `Connect the drive with ${series.root}, then reload this page. Your flashcards are still available under Review and Deck.`));
  }
  if (!series.episodes.length) {
    return h('div', { class: 'empty' },
      h('h2', {}, `No episodes found in ${series.title}`),
      h('p', {}, `Episodes should be in folders like “Season 1/01 - Title” inside ${series.root}.`));
  }
  const { episodes, language } = series;
  const FILTERS = {
    both: { label: `${language.name} + English`, test: (e) => e.hasStudy && e.hasEn },
    subs: { label: 'Any subtitles', test: (e) => e.hasStudy || e.hasEn },
    all: { label: 'All', test: () => true },
  };
  let filter = pref('library-filter', 'both');
  const list = h('div', { class: 'library-list' });
  const buttons = Object.entries(FILTERS).map(([key, f]) => h('button', {
    type: 'button',
    onclick: () => { filter = key; setPref('library-filter', key); draw(); },
  }, `${f.label} (${episodes.filter(f.test).length})`));

  function draw() {
    Object.keys(FILTERS).forEach((key, i) => buttons[i].setAttribute('aria-pressed', key === filter));
    list.replaceChildren();
    const shown = episodes.filter(FILTERS[filter].test);
    if (!shown.length) list.append(h('p', { class: 'muted season' }, 'No episodes match this filter. Choose All to see the rest.'));
    for (const season of new Set(shown.map((e) => e.season))) {
      list.append(
        h('h2', { class: 'season' }, `Season ${season}`),
        h('ul', { class: 'episode-grid' }, shown.filter((e) => e.season === season).map((ep) => {
          const [label, tone] = subtitleLabel(ep);
          return h('li', {}, h('a', { class: 'episode', href: `#/ep/${ep.id}` },
            h('span', { class: 'episode-number' }, String(ep.number).padStart(2, '0')),
            h('span', { class: 'episode-title' }, ep.title),
            h('span', { class: `tag tag-${tone}` }, label)));
        })));
    }
  }
  draw();
  return h('div', {},
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Filter by subtitles' }, buttons),
    list);
}

async function renderLibrary(root) {
  const { series } = await api('/api/episodes');
  let current = series.find((s) => s.id === pref('library-series', null)) ?? series[0];
  const body = h('div', {});
  const heading = h('h1', {});
  const tabs = series.map((s) => h('button', {
    type: 'button',
    onclick: () => { current = s; setPref('library-series', s.id); draw(); },
  }, s.title));

  function draw() {
    series.forEach((s, i) => tabs[i].setAttribute('aria-pressed', s === current));
    heading.textContent = current.title;
    body.replaceChildren(renderSeries(current));
  }
  draw();
  root.append(h('div', { class: 'library' },
    series.length > 1 ? h('div', { class: 'segmented series-tabs', role: 'group', 'aria-label': 'Series' }, tabs) : null,
    h('div', { class: 'library-head' }, heading),
    body));
}

async function route() {
  cleanup?.();
  cleanup = null;
  const [path, query] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  const name = parts[0] === 'ep' ? 'reader' : parts[0] ?? 'library';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('current', a.dataset.nav === name));
  document.body.classList.toggle('in-reader', name === 'reader');

  const root = h('div', { class: 'view-root' });
  view.replaceChildren(root);
  try {
    if (name === 'reader') {
      cleanup = await renderReader(root, parts[1], new URLSearchParams(query));
    } else if (name === 'review') {
      cleanup = await renderReview(root);
    } else if (name === 'deck') {
      await renderDeck(root);
    } else {
      await renderLibrary(root);
    }
  } catch (err) {
    root.replaceChildren(h('div', { class: 'empty' }, h('h1', {}, 'That did not load'), h('p', {}, err.message)));
  }
  refreshDueBadge();
}

window.addEventListener('hashchange', route);
route();
