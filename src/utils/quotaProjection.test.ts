import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildQuotaProjection,
  collectQuotaWindowSamples,
  projectionValueAt,
  resolveProjectionHorizonMs,
  toTimestampMs,
  type QuotaWindowSample,
} from './quotaProjection';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const t = (_key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : _key);

function sample(overrides: Partial<QuotaWindowSample>): QuotaWindowSample {
  return {
    accountId: 'a',
    accountName: 'a@example.com',
    plan: 'PRO',
    windowKey: 'weekly',
    windowLabel: 'Weekly',
    cycle: 'long',
    remainingPercent: 50,
    resetAtMs: NOW + DAY,
    ...overrides,
  };
}

test('timestamps accept seconds, milliseconds and date strings', () => {
  assert.equal(toTimestampMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(toTimestampMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(toTimestampMs('2026-11-06T12:00:00Z'), NOW);
  assert.equal(toTimestampMs('1700000000'), 1_700_000_000_000);
  assert.equal(toTimestampMs(0), null);
  assert.equal(toTimestampMs('not a date'), null);
  assert.equal(toTimestampMs(undefined), null);
});

test('pool level steps up exactly at each reset and reports when it is full', () => {
  const projection = buildQuotaProjection([
    sample({ accountId: 'a', accountName: 'a', remainingPercent: 20, resetAtMs: NOW + DAY }),
    sample({ accountId: 'b', accountName: 'b', remainingPercent: 60, resetAtMs: NOW + 3 * DAY }),
  ], 'long', NOW);

  assert.equal(projection.series.length, 1);
  const [series] = projection.series;
  assert.deepEqual(series.points.map((point) => [point.timeMs - NOW, point.percent]), [
    [0, 40],
    [DAY, 80],
    [3 * DAY, 100],
  ]);
  assert.equal(series.points[0].accountsLeft, 0.8);
  assert.equal(series.fullNow, false);
  assert.equal(series.fullAtMs, NOW + 3 * DAY);
  assert.deepEqual(series.resets.map((reset) => [reset.accountName, reset.gainPercent]), [['a', 80], ['b', 40]]);
  assert.equal(projectionValueAt(series, NOW + 2 * DAY).percent, 80);
  assert.equal(projectionValueAt(series, NOW + DAY - 1).percent, 40);
});

test('a reset time in the past counts as already full', () => {
  const [series] = buildQuotaProjection([
    sample({ remainingPercent: 10, resetAtMs: NOW - HOUR }),
  ], 'long', NOW).series;
  assert.equal(series.points[0].percent, 100);
  assert.equal(series.fullNow, true);
  assert.equal(series.fullAtMs, null);
  assert.equal(series.resets.length, 0);
});

test('an account without a known reset keeps the pool from reaching full', () => {
  const [series] = buildQuotaProjection([
    sample({ accountId: 'a', remainingPercent: 30, resetAtMs: null }),
    sample({ accountId: 'b', remainingPercent: 50, resetAtMs: NOW + DAY }),
  ], 'long', NOW).series;
  assert.equal(series.points[series.points.length - 1].percent, 65);
  assert.equal(series.fullAtMs, null);
  assert.equal(series.fullNow, false);
});

test('series split by window and plan, naming the plan only when a window has several', () => {
  const projection = buildQuotaProjection([
    sample({ windowKey: 'weekly', windowLabel: 'Weekly', plan: 'PRO' }),
    sample({ windowKey: 'weekly', windowLabel: 'Weekly', plan: 'Free' }),
    sample({ windowKey: 'monthly', windowLabel: 'Monthly', plan: 'PRO' }),
    sample({ windowKey: 'session', windowLabel: 'Session', cycle: 'short', resetAtMs: NOW + HOUR }),
  ], 'long', NOW);
  assert.deepEqual(projection.series.map((series) => series.label), ['Monthly', 'Weekly · Free', 'Weekly · PRO']);
});

test('horizon covers the latest reset with a minimum per cycle', () => {
  assert.equal(resolveProjectionHorizonMs([], 'short', NOW), 6 * HOUR);
  assert.equal(resolveProjectionHorizonMs([], 'long', NOW), 7 * DAY);
  assert.equal(resolveProjectionHorizonMs([sample({ cycle: 'short', resetAtMs: NOW + 9 * HOUR })], 'short', NOW), 10 * HOUR);
  assert.equal(resolveProjectionHorizonMs([sample({ resetAtMs: NOW + 20 * DAY })], 'long', NOW), 21 * DAY);
});

test('Claude windows use raw used percentages, independent of the display preference', () => {
  const samples = collectQuotaWindowSamples('claude', [
    {
      id: 'c1',
      email: 'c@example.com',
      quota: {
        five_hour_percentage: 75,
        five_hour_reset_time: Math.floor((NOW + 2 * HOUR) / 1000),
        seven_day_percentage: 40,
        seven_day_reset_time: Math.floor((NOW + 3 * DAY) / 1000),
      },
    },
    { id: 'c2', email: 'off@example.com', disabled: true, quota: { five_hour_percentage: 0 } },
  ], t);
  assert.deepEqual(
    samples.map((item) => [item.windowKey, item.cycle, item.remainingPercent, item.resetAtMs]),
    [
      ['five_hour', 'short', 25, NOW + 2 * HOUR],
      ['seven_day', 'long', 60, NOW + 3 * DAY],
    ],
  );
});

test('Codex windows already measure percent left', () => {
  const samples = collectQuotaWindowSamples('codex', [
    {
      id: 'x1',
      email: 'x@example.com',
      quota: {
        hourly_percentage: 30,
        hourly_reset_time: Math.floor((NOW + 2 * HOUR) / 1000),
        hourly_window_minutes: 300,
        weekly_percentage: 80,
        weekly_reset_time: Math.floor((NOW + 4 * DAY) / 1000),
        weekly_window_minutes: 10080,
      },
    },
  ], t);
  assert.deepEqual(
    samples.map((item) => [item.windowKey, item.cycle, item.remainingPercent, item.resetAtMs]),
    [
      ['primary', 'short', 30, NOW + 2 * HOUR],
      ['secondary', 'long', 80, NOW + 4 * DAY],
    ],
  );
});
