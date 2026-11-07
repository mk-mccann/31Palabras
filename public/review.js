import { api, cardSource, h, refreshDueBadge, termPattern } from './util.js';

const GRADES = ['Again', 'Hard', 'Good', 'Easy'];

function withTermMarked(context, term) {
  const pattern = termPattern([term]);
  if (!pattern) return [context];
  const nodes = [];
  let last = 0;
  for (const match of context.matchAll(pattern)) {
    nodes.push(context.slice(last, match.index), h('mark', { class: 'highlight' }, match[0]));
    last = match.index + match[0].length;
  }
  nodes.push(context.slice(last));
  return nodes;
}

function clipPlayer(card) {
  if (!card.episodeId || card.start == null) return null;
  const video = h('video', { preload: 'none', hidden: true });
  const note = h('span', { class: 'muted' });
  let loaded = false;
  const seekAndPlay = () => {
    video.currentTime = card.start;
    video.play().catch(() => {});
  };
  video.addEventListener('timeupdate', () => { if (card.end != null && video.currentTime >= card.end) video.pause(); });
  video.addEventListener('error', () => { note.textContent = "Can't play the clip. Check that the drive is connected."; });
  const button = h('button', {
    type: 'button',
    class: 'control',
    onclick: () => {
      video.hidden = false;
      if (loaded) return seekAndPlay();
      loaded = true;
      note.textContent = 'Loading…';
      video.preload = 'metadata';
      video.src = `/media/${card.episodeId}.mp4`;
      video.addEventListener('loadedmetadata', () => { note.textContent = ''; seekAndPlay(); }, { once: true });
      return undefined;
    },
  }, 'Play the scene');
  return { el: h('div', { class: 'clip' }, h('div', { class: 'clip-row' }, button, note), video), video, play: () => button.click() };
}

export async function renderReview(root) {
  const cards = await api('/api/cards');
  const queue = cards.filter((c) => c.due <= Date.now()).sort((a, b) => a.due - b.due);
  let reviewed = 0;
  let revealed = false;
  let clip = null;
  const stage = h('div', { class: 'review' });
  root.append(stage);

  function finish() {
    clip = null;
    stage.replaceChildren(h('div', { class: 'empty' },
      cards.length === 0
        ? [h('h1', {}, 'No flashcards yet'), h('p', {}, 'Open an episode, click a word in the transcript, and add it to your deck.'), h('a', { class: 'button primary', href: '#/' }, 'Choose an episode')]
        : [h('h1', {}, reviewed ? 'All caught up' : 'Nothing due right now'),
          h('p', {}, reviewed ? `You reviewed ${reviewed} ${reviewed === 1 ? 'card' : 'cards'}.` : `${cards.length} ${cards.length === 1 ? 'card' : 'cards'} in your deck.`),
          h('a', { class: 'button', href: '#/' }, 'Back to episodes')]));
  }

  async function grade(value) {
    const card = queue.shift();
    clip?.video.pause();
    await api(`/api/cards/${card.id}/review`, { method: 'POST', body: { grade: value } });
    reviewed++;
    if (value === 0) queue.push(card);
    refreshDueBadge();
    draw();
  }

  function draw() {
    const card = queue[0];
    if (!card) return finish();
    revealed = false;
    clip = clipPlayer(card);
    const back = h('div', { class: 'card-back', hidden: true },
      h('p', { class: 'card-meaning' }, card.meaning || '(no meaning saved)'),
      card.note ? h('p', { class: 'card-note' }, card.note) : null,
      card.contextEn ? h('p', { class: 'card-context muted', lang: 'en' }, card.contextEn) : null,
      card.episodeId ? h('a', { class: 'source-link', href: `#/ep/${card.episodeId}?t=${card.start ?? 0}` }, cardSource(card)) : null);
    const previews = card.previews;
    const gradeRow = h('div', { class: 'grades', hidden: true }, GRADES.map((label, value) =>
      h('button', { type: 'button', class: `grade grade-${value}`, onclick: () => grade(value) },
        h('span', {}, label), h('small', {}, previews[value]))));
    const revealButton = h('button', { type: 'button', class: 'primary reveal', onclick: () => reveal() }, 'Show answer');

    function reveal() {
      revealed = true;
      back.hidden = false;
      gradeRow.hidden = false;
      revealButton.hidden = true;
    }
    stage.reveal = reveal;

    stage.replaceChildren(
      h('p', { class: 'review-progress muted' }, `${queue.length} left · Space shows the answer, 1–4 grades it, P plays the scene`),
      h('article', { class: 'flashcard' },
        h('h1', { class: 'card-term', lang: card.lang }, card.term),
        card.contextStudy ? h('p', { class: 'card-context', lang: card.lang }, withTermMarked(card.contextStudy, card.term)) : null,
        clip?.el,
        back),
      revealButton,
      gradeRow);
    return undefined;
  }

  function onKey(event) {
    if (event.target.closest?.('input, textarea') || event.metaKey || event.ctrlKey || event.altKey || !queue.length) return;
    if (event.key === ' ' && !revealed) {
      event.preventDefault();
      stage.reveal();
    } else if (revealed && ['1', '2', '3', '4'].includes(event.key)) {
      grade(Number(event.key) - 1);
    } else if (event.key === 'p') {
      clip?.play();
    }
  }
  document.addEventListener('keydown', onKey);
  draw();

  return () => {
    document.removeEventListener('keydown', onKey);
    clip?.video.pause();
  };
}
