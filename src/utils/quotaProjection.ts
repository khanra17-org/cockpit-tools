import type { Account } from '../types/account';
import type { ClaudeAccount } from '../types/claude';
import type { CodexAccount } from '../types/codex';
import type { CursorAccount } from '../types/cursor';
import type { WindsurfAccount } from '../types/windsurf';
import {
  buildAntigravityAccountPresentation,
  buildClaudeAccountPresentation,
  buildCodexAccountPresentation,
  buildCursorAccountPresentation,
  buildWindsurfAccountPresentation,
  type UnifiedAccountPresentation,
} from '../presentation/platformAccountPresentation';

/**
 * Projects how much quota a set of accounts will have left over time, assuming
 * no further usage: each account's window stays at its current level until it
 * resets, then counts as full.
 */

export type QuotaProjectionPlatform = 'antigravity' | 'claude' | 'codex' | 'cursor' | 'windsurf';
export type QuotaProjectionCycle = 'short' | 'long';

type Translate = (key: string, options?: any) => string;

/** One quota window of one account, normalized to "percent left". */
export interface QuotaWindowSample {
  accountId: string;
  accountName: string;
  plan: string;
  windowKey: string;
  windowLabel: string;
  cycle: QuotaProjectionCycle;
  remainingPercent: number;
  resetAtMs: number | null;
}

export interface QuotaProjectionPoint {
  timeMs: number;
  /** Combined quota left, as a percent of the pool's full capacity (0-100). */
  percent: number;
  /** Combined quota left in "whole accounts" (sum of percent left / 100). */
  accountsLeft: number;
}

export interface QuotaProjectionReset {
  timeMs: number;
  accountName: string;
  /** Percent of one account's window that comes back at this reset. */
  gainPercent: number;
}

export interface QuotaProjectionSeries {
  id: string;
  label: string;
  windowKey: string;
  plan: string;
  accountCount: number;
  /** Step points: the value holds from each point until the next one. */
  points: QuotaProjectionPoint[];
  resets: QuotaProjectionReset[];
  /** Every account in the pool already has its full window. */
  fullNow: boolean;
  /**
   * When the pool is back to 100% within the horizon. Null when it is already
   * full, or when some account has no known reset inside the horizon.
   */
  fullAtMs: number | null;
}

export interface QuotaProjection {
  cycle: QuotaProjectionCycle;
  startMs: number;
  endMs: number;
  series: QuotaProjectionSeries[];
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Accepts Unix seconds, Unix milliseconds or a date string. */
export function toTimestampMs(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return toTimestampMs(numeric);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/**
 * How each platform's presentation items are read. Presentation percentages
 * mean "left" on some platforms and "used" on others, so each window the chart
 * understands is listed explicitly; anything else (credits, balances, metered
 * usage without a reset) is ignored.
 */
const WINDOW_RULES: Record<
  Exclude<QuotaProjectionPlatform, 'claude'>,
  Record<string, { measures: 'left' | 'used'; cycle: QuotaProjectionCycle }>
> = {
  antigravity: {
    'claude:5h': { measures: 'left', cycle: 'short' },
    'gemini:5h': { measures: 'left', cycle: 'short' },
    'claude:weekly': { measures: 'left', cycle: 'long' },
    'gemini:weekly': { measures: 'left', cycle: 'long' },
    'argon:weekly': { measures: 'left', cycle: 'long' },
  },
  codex: {
    primary: { measures: 'left', cycle: 'short' },
    secondary: { measures: 'left', cycle: 'long' },
  },
  cursor: {
    total: { measures: 'used', cycle: 'long' },
  },
  windsurf: {
    daily_quota: { measures: 'used', cycle: 'short' },
    weekly_quota: { measures: 'used', cycle: 'long' },
  },
};

function isInactive(account: unknown): boolean {
  const record = account as { disabled?: boolean; quota?: { is_forbidden?: boolean } } | null;
  return !record || record.disabled === true || record.quota?.is_forbidden === true;
}

function samplesFromPresentation(
  platform: Exclude<QuotaProjectionPlatform, 'claude'>,
  presentation: UnifiedAccountPresentation,
): QuotaWindowSample[] {
  const rules = WINDOW_RULES[platform];
  const samples: QuotaWindowSample[] = [];
  for (const item of presentation.quotaItems) {
    const rule = rules[item.key];
    if (!rule) continue;
    const value = clampPercent(item.percentage);
    samples.push({
      accountId: presentation.id,
      accountName: presentation.displayName || presentation.id,
      plan: (presentation.planLabel || '').trim(),
      windowKey: item.key,
      windowLabel: item.label,
      cycle: rule.cycle,
      remainingPercent: rule.measures === 'left' ? value : 100 - value,
      resetAtMs: toTimestampMs(item.resetAt),
    });
  }
  return samples;
}

/**
 * Claude's presentation follows the user's "show used / show remaining"
 * preference, so its windows are read from the raw used percentages instead.
 */
function claudeSamples(account: ClaudeAccount, t: Translate): QuotaWindowSample[] {
  const quota = account.quota;
  if (!quota) return [];
  const presentation = buildClaudeAccountPresentation(account, t);
  const base = {
    accountId: presentation.id,
    accountName: presentation.displayName || presentation.id,
    plan: (presentation.planLabel || '').trim(),
  };
  const samples: QuotaWindowSample[] = [];
  if (Number.isFinite(quota.five_hour_percentage)) {
    samples.push({
      ...base,
      windowKey: 'five_hour',
      windowLabel: t('claude.quota.fiveHour', 'Current session'),
      cycle: 'short',
      remainingPercent: 100 - clampPercent(quota.five_hour_percentage),
      resetAtMs: toTimestampMs(quota.five_hour_reset_time),
    });
  }
  if (typeof quota.seven_day_percentage === 'number' && Number.isFinite(quota.seven_day_percentage)) {
    samples.push({
      ...base,
      windowKey: 'seven_day',
      windowLabel: t('claude.quota.sevenDay', 'Current week (all models)'),
      cycle: 'long',
      remainingPercent: 100 - clampPercent(quota.seven_day_percentage),
      resetAtMs: toTimestampMs(quota.seven_day_reset_time),
    });
  }
  return samples;
}

export function collectQuotaWindowSamples(
  platform: QuotaProjectionPlatform,
  accounts: readonly unknown[],
  t: Translate,
): QuotaWindowSample[] {
  const samples: QuotaWindowSample[] = [];
  for (const account of accounts) {
    if (isInactive(account)) continue;
    try {
      switch (platform) {
        case 'antigravity':
          samples.push(...samplesFromPresentation(platform, buildAntigravityAccountPresentation(account as Account, [], t)));
          break;
        case 'codex':
          samples.push(...samplesFromPresentation(platform, buildCodexAccountPresentation(account as CodexAccount, t)));
          break;
        case 'cursor':
          samples.push(...samplesFromPresentation(platform, buildCursorAccountPresentation(account as CursorAccount, t)));
          break;
        case 'windsurf':
          samples.push(...samplesFromPresentation(platform, buildWindsurfAccountPresentation(account as WindsurfAccount, t)));
          break;
        case 'claude':
          samples.push(...claudeSamples(account as ClaudeAccount, t));
          break;
      }
    } catch (error) {
      console.warn(`[QuotaProjection] Skipped an unreadable ${platform} account`, error);
    }
  }
  return samples;
}

/** Short windows show at least 6 hours; long ones at least 7 days. */
export function resolveProjectionHorizonMs(
  samples: readonly QuotaWindowSample[],
  cycle: QuotaProjectionCycle,
  nowMs: number,
): number {
  const latestReset = samples.reduce((latest, sample) => {
    if (sample.resetAtMs == null || sample.resetAtMs <= nowMs) return latest;
    return Math.max(latest, sample.resetAtMs - nowMs);
  }, 0);
  if (cycle === 'short') {
    return Math.max(6 * HOUR_MS, Math.ceil((latestReset + HOUR_MS / 2) / HOUR_MS) * HOUR_MS);
  }
  return Math.max(7 * DAY_MS, Math.ceil((latestReset + HOUR_MS * 6) / DAY_MS) * DAY_MS);
}

export function buildQuotaProjection(
  allSamples: readonly QuotaWindowSample[],
  cycle: QuotaProjectionCycle,
  nowMs: number,
): QuotaProjection {
  const samples = allSamples.filter((sample) => sample.cycle === cycle);
  const endMs = nowMs + resolveProjectionHorizonMs(samples, cycle, nowMs);

  const groups = new Map<string, QuotaWindowSample[]>();
  for (const sample of samples) {
    const id = `${sample.windowKey}\u0000${sample.plan.toUpperCase()}`;
    const group = groups.get(id);
    if (group) group.push(sample);
    else groups.set(id, [sample]);
  }

  // Only name the plan when one window is split across several plans.
  const plansPerWindow = new Map<string, Set<string>>();
  for (const sample of samples) {
    const plans = plansPerWindow.get(sample.windowKey) ?? new Set<string>();
    plans.add(sample.plan.toUpperCase());
    plansPerWindow.set(sample.windowKey, plans);
  }

  const series: QuotaProjectionSeries[] = [];
  for (const [id, group] of groups) {
    const first = group[0];
    const count = group.length;
    // A window whose reset time has passed is treated as already full.
    const levelAt = (timeMs: number) =>
      group.reduce(
        (sum, sample) =>
          sum + (sample.resetAtMs != null && sample.resetAtMs <= timeMs ? 100 : sample.remainingPercent),
        0,
      );
    const toPoint = (timeMs: number): QuotaProjectionPoint => {
      const total = levelAt(timeMs);
      return { timeMs, percent: total / count, accountsLeft: total / 100 };
    };

    const resets: QuotaProjectionReset[] = group
      .filter(
        (sample) =>
          sample.resetAtMs != null &&
          sample.resetAtMs > nowMs &&
          sample.resetAtMs <= endMs &&
          sample.remainingPercent < 100,
      )
      .map((sample) => ({
        timeMs: sample.resetAtMs as number,
        accountName: sample.accountName,
        gainPercent: 100 - sample.remainingPercent,
      }))
      .sort((a, b) => a.timeMs - b.timeMs);

    const stepTimes = [...new Set(resets.map((reset) => reset.timeMs))];
    const points = [nowMs, ...stepTimes].map(toPoint);
    const fullNow = points[0].percent >= 100;
    const fullAtMs =
      !fullNow && stepTimes.length > 0 && points[points.length - 1].percent >= 100
        ? stepTimes[stepTimes.length - 1]
        : null;

    const plans = plansPerWindow.get(first.windowKey);
    const label = plans && plans.size > 1 && first.plan ? `${first.windowLabel} · ${first.plan}` : first.windowLabel;

    series.push({
      id,
      label,
      windowKey: first.windowKey,
      plan: first.plan,
      accountCount: count,
      points,
      resets,
      fullNow,
      fullAtMs,
    });
  }

  series.sort((a, b) => a.label.localeCompare(b.label));
  return { cycle, startMs: nowMs, endMs, series };
}

/** Value of a step series at a given time. */
export function projectionValueAt(series: QuotaProjectionSeries, timeMs: number): QuotaProjectionPoint {
  let current = series.points[0];
  for (const point of series.points) {
    if (point.timeMs <= timeMs) current = point;
    else break;
  }
  return current;
}
