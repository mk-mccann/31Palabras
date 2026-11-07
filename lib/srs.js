// A small SM-2 style scheduler. Grades: 0 again, 1 hard, 2 good, 3 easy.

const MINUTE = 60_000;
const DAY = 86_400_000;
const MIN_EASE = 1.3;

export const newSchedule = (now = Date.now()) => ({ ease: 2.5, interval: 0, reps: 0, lapses: 0, due: now });

export function nextSchedule(card, grade, now = Date.now()) {
  let { ease, interval, reps, lapses } = card;
  if (grade === 0) {
    return { ease: Math.max(MIN_EASE, ease - 0.2), interval: 0, reps: 0, lapses: lapses + 1, due: now + 10 * MINUTE };
  }
  if (grade === 1) {
    interval = Math.max(1, reps === 0 ? 1 : interval * 1.2);
    ease = Math.max(MIN_EASE, ease - 0.15);
  } else if (reps === 0) {
    interval = grade === 3 ? 4 : 1;
  } else if (reps === 1) {
    interval = grade === 3 ? 8 : 4;
  } else {
    interval *= grade === 3 ? ease * 1.3 : ease;
  }
  if (grade === 3) ease += 0.15;
  interval = Math.round(interval * 10) / 10;
  return { ease, interval, reps: reps + 1, lapses, due: now + interval * DAY };
}

export function intervalLabel(card, grade) {
  const { interval } = nextSchedule(card, grade, 0);
  if (grade === 0) return '10 min';
  if (interval < 30) return `${Math.round(interval)} d`;
  if (interval < 365) return `${Math.round(interval / 30)} mo`;
  return `${(interval / 365).toFixed(1)} y`;
}
