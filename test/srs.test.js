import assert from 'node:assert/strict';
import { test } from 'node:test';
import { intervalLabel, newSchedule, nextSchedule } from '../lib/srs.js';

const DAY = 86_400_000;

test('good answers grow the interval', () => {
  let card = newSchedule(0);
  card = nextSchedule(card, 2, 0);
  assert.equal(card.interval, 1);
  card = nextSchedule(card, 2, 0);
  assert.equal(card.interval, 4);
  card = nextSchedule(card, 2, 0);
  assert.equal(card.interval, 10);
  assert.equal(card.due, 10 * DAY);
});

test('again resets the card and brings it back in ten minutes', () => {
  const card = nextSchedule({ ease: 2.5, interval: 30, reps: 5, lapses: 0, due: 0 }, 0, 1000);
  assert.deepEqual(card, { ease: 2.3, interval: 0, reps: 0, lapses: 1, due: 1000 + 600_000 });
});

test('ease never falls below the floor', () => {
  let card = newSchedule(0);
  for (let i = 0; i < 20; i++) card = nextSchedule(card, 0, 0);
  assert.equal(card.ease, 1.3);
});

test('interval labels', () => {
  const card = { ease: 2.5, interval: 40, reps: 4, lapses: 0, due: 0 };
  assert.equal(intervalLabel(card, 0), '10 min');
  assert.equal(intervalLabel(card, 2), '3 mo');
});
