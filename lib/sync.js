// Corrects an episode's subtitle timing from anchors: "the line that the subtitles
// put at `from` is really spoken at `to`". One anchor shifts everything; between
// two anchors the timing is stretched, which also fixes drift.

export function remap(time, anchors) {
  if (!anchors.length) return time;
  const first = anchors[0];
  const last = anchors.at(-1);
  if (time <= first.from) return time + first.to - first.from;
  if (time >= last.from) return time + last.to - last.from;
  const next = anchors.findIndex((a) => a.from > time);
  const a = anchors[next - 1];
  const b = anchors[next];
  return a.to + ((time - a.from) * (b.to - a.to)) / (b.from - a.from);
}

export const invert = (anchors) => anchors.map(({ from, to }) => ({ from: to, to: from }));

// Time has to keep moving forward, so a new anchor replaces any it would cross.
export function addAnchor(anchors, anchor) {
  const kept = anchors.filter((a) => (a.from < anchor.from && a.to < anchor.to) || (a.from > anchor.from && a.to > anchor.to));
  return [...kept, anchor].sort((a, b) => a.from - b.from);
}

export function syncRows(rows, anchors) {
  return rows.map((row) => ({
    ...row,
    start: Math.max(0, remap(row.start, anchors)),
    end: Math.max(0, remap(row.end, anchors)),
    synced: anchors.some((a) => a.from === row.start),
  }));
}
