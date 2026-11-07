export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

// Builds DOM nodes; text always goes in as text nodes, so subtitle and lookup
// content can never be interpreted as markup.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key in el && key !== 'list') el[key] = value;
    else el.setAttribute(key, value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

export function formatTime(total) {
  const t = Math.max(0, Math.floor(total));
  const hours = Math.floor(t / 3600);
  const minutes = Math.floor((t % 3600) / 60);
  const seconds = String(t % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

export const cardSource = (card) => [card.seriesTitle, card.episodeTitle, formatTime(card.start ?? 0)].filter(Boolean).join(' · ');

export const normalizeTerm = (term) => term.trim().toLocaleLowerCase('es');

// Matches whole terms only, so "pan" doesn't light up inside "pantalón".
export function termPattern(terms) {
  const escaped = [...new Set(terms.map(normalizeTerm).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  return escaped.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;
}

export function pref(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : JSON.parse(stored);
  } catch {
    return fallback;
  }
}

export function setPref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Preferences are a convenience; carry on without them.
  }
}

// Fills in once DeepL answers; stays empty if there's no key or no answer.
export function deeplUsageNote() {
  const note = h('span', { class: 'deepl-usage' });
  api('/api/deepl-usage').then(({ configured, used, limit }) => {
    if (configured) note.textContent = `DeepL: ${used.toLocaleString()} of ${limit.toLocaleString()} characters used`;
  }).catch(() => {});
  return note;
}

let toastTimer;
export function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

export async function refreshDueBadge() {
  const cards = await api('/api/cards').catch(() => []);
  const due = cards.filter((c) => c.due <= Date.now()).length;
  const badge = document.getElementById('due-badge');
  badge.textContent = due;
  badge.hidden = due === 0;
}
