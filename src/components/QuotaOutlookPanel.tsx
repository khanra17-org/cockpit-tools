import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  buildQuotaProjection,
  collectQuotaWindowSamples,
  projectionValueAt,
  type QuotaProjectionCycle,
  type QuotaProjectionPlatform,
  type QuotaProjectionSeries,
} from '../utils/quotaProjection';
import {
  PRIVACY_MODE_CHANGED_EVENT,
  isPrivacyModeEnabledByDefault,
  maskSensitiveValue,
} from '../utils/privacy';
import './QuotaOutlookPanel.css';

export interface QuotaOutlookPanelProps {
  platform: QuotaProjectionPlatform;
  /** The accounts currently shown on the page (after search and filters). */
  accounts: readonly unknown[];
}

const CHART_HEIGHT = 200;
const PLOT = { top: 14, right: 16, bottom: 28, left: 44 };
const SERIES_COLOR_COUNT = 5;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function readCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(key: string, collapsed: boolean) {
  try {
    if (collapsed) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable; the panel still works without remembering.
  }
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function formatAccounts(value: number): string {
  return value >= 10 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1);
}

const MIN_TICK_GAP_PX = 72;

/** Smallest tick spacing that keeps labels at least MIN_TICK_GAP_PX apart. */
function pickTickStepMs(spanMs: number, plotWidthPx: number): number {
  const maxTicks = Math.max(1, Math.min(8, Math.floor(plotWidthPx / MIN_TICK_GAP_PX)));
  const steps = [HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS, DAY_MS, 2 * DAY_MS, 7 * DAY_MS];
  return steps.find((step) => spanMs / step <= maxTicks) ?? 14 * DAY_MS;
}

export function QuotaOutlookPanel({ platform, accounts }: QuotaOutlookPanelProps) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const storageKey = `agtools.${platform}.quota_outlook_collapsed`;
  const [collapsed, setCollapsed] = useState(() => readCollapsed(storageKey));
  const [cycle, setCycle] = useState<QuotaProjectionCycle>('long');
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [width, setWidth] = useState(0);
  const [privacyMode, setPrivacyMode] = useState(() => isPrivacyModeEnabledByDefault());
  const wrapRef = useRef<HTMLDivElement>(null);

  // Keep "now" fresh so resets slide left and drop off as time passes.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Follow the app-wide "hide emails" switch; reset rows name accounts.
  useEffect(() => {
    const sync = () => setPrivacyMode(isPrivacyModeEnabledByDefault());
    window.addEventListener(PRIVACY_MODE_CHANGED_EVENT, sync);
    return () => window.removeEventListener(PRIVACY_MODE_CHANGED_EVENT, sync);
  }, []);

  const samples = useMemo(() => collectQuotaWindowSamples(platform, accounts, t), [platform, accounts, t]);
  const hasData = samples.length > 0;

  // The chart wrapper only exists while there is data and the panel is open.
  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [collapsed, hasData]);

  const availableCycles = useMemo(() => {
    const cycles = new Set(samples.map((sample) => sample.cycle));
    return (['long', 'short'] as const).filter((value) => cycles.has(value));
  }, [samples]);
  const activeCycle = availableCycles.includes(cycle) ? cycle : availableCycles[0] ?? cycle;
  const projection = useMemo(
    () => buildQuotaProjection(samples, activeCycle, nowMs),
    [samples, activeCycle, nowMs],
  );

  const colorIndexById = useMemo(
    () => new Map(projection.series.map((series, index) => [series.id, index % SERIES_COLOR_COUNT])),
    [projection.series],
  );
  const visibleSeries = projection.series.filter((series) => !hiddenIds.includes(series.id));

  if (!hasData) return null;

  const locale = i18n.language || undefined;
  const span = projection.endMs - projection.startMs;
  const formatMoment = (timeMs: number) =>
    new Date(timeMs).toLocaleString(locale, {
      weekday: 'short',
      month: span > 7 * DAY_MS ? 'short' : undefined,
      day: span > 7 * DAY_MS ? 'numeric' : undefined,
      hour: '2-digit',
      minute: '2-digit',
    });
  const formatTick = (timeMs: number) =>
    activeCycle === 'short' || span <= 2 * DAY_MS
      ? new Date(timeMs).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      : new Date(timeMs).toLocaleDateString(locale, span > 7 * DAY_MS
        ? { month: 'short', day: 'numeric' }
        : { weekday: 'short', day: 'numeric' });
  const describeFull = (series: QuotaProjectionSeries) =>
    series.fullNow
      ? t('common.shared.quotaProjection.fullNow')
      : series.fullAtMs != null
        ? t('common.shared.quotaProjection.fullAt', { time: formatMoment(series.fullAtMs) })
        : t('common.shared.quotaProjection.notFullInRange');

  const plotWidth = Math.max(0, width - PLOT.left - PLOT.right);
  const plotHeight = CHART_HEIGHT - PLOT.top - PLOT.bottom;
  const xOf = (timeMs: number) => PLOT.left + ((timeMs - projection.startMs) / span) * plotWidth;
  const yOf = (percent: number) => PLOT.top + plotHeight - (percent / 100) * plotHeight;
  const bottomY = PLOT.top + plotHeight;

  const stepPath = (series: QuotaProjectionSeries) => {
    const [first, ...rest] = series.points;
    let path = `M ${xOf(first.timeMs)} ${yOf(first.percent)}`;
    for (const point of rest) {
      path += ` H ${xOf(point.timeMs)} V ${yOf(point.percent)}`;
    }
    return `${path} H ${xOf(projection.endMs)}`;
  };

  const tickStep = pickTickStepMs(span, plotWidth);
  const xTicks: number[] = [];
  const firstTick = Math.ceil(projection.startMs / tickStep) * tickStep;
  for (let tick = firstTick; tick < projection.endMs; tick += tickStep) {
    // Leave room for the "Now" label and keep the last label inside the plot.
    const x = xOf(tick);
    if (x - PLOT.left >= MIN_TICK_GAP_PX * 0.75 && PLOT.left + plotWidth - x >= MIN_TICK_GAP_PX / 2) {
      xTicks.push(tick);
    }
  }

  const resetMarkers = visibleSeries.flatMap((series) =>
    series.resets.map((reset) => ({ ...reset, seriesId: series.id })),
  );

  const handlePointerMove = (event: PointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    setHoverTime(projection.startMs + ratio * span);
  };

  const hoverX = hoverTime == null ? null : xOf(hoverTime);
  const nearWindowMs = Math.max(10 * 60 * 1000, span / 40);
  const hoverResets = hoverTime == null
    ? []
    : resetMarkers.filter((reset) => Math.abs(reset.timeMs - hoverTime) <= nearWindowMs);
  // Keep the tooltip inside the plot, beside the crosshair, flipping sides past the middle.
  const tooltipStyle = hoverX == null
    ? undefined
    : hoverX > width / 2
      ? { right: width - hoverX + 12 }
      : { left: hoverX + 12 };

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      writeCollapsed(storageKey, !value);
      return !value;
    });
  };
  const toggleSeries = (id: string) =>
    setHiddenIds((ids) => (ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]));

  const chartSummary = visibleSeries
    .map((series) => `${series.label}: ${formatPercent(series.points[0].percent)}, ${describeFull(series)}`)
    .join('; ');

  return (
    <section className={`quota-outlook${collapsed ? ' is-collapsed' : ''}`} aria-labelledby={titleId}>
      <div className="quota-outlook__header">
        <div className="quota-outlook__heading">
          <h2 id={titleId}>{t('common.shared.quotaProjection.title')}</h2>
          {!collapsed && (
            <span className="quota-outlook__caption">{t('common.shared.quotaProjection.caption')}</span>
          )}
        </div>
        <div className="quota-outlook__actions">
          {!collapsed && availableCycles.length > 1 && (
            <div className="quota-outlook__cycles" role="group" aria-label={t('common.shared.quotaProjection.cyclesLabel')}>
              {availableCycles.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`btn btn-secondary btn-sm${activeCycle === value ? ' is-active' : ''}`}
                  aria-pressed={activeCycle === value}
                  onClick={() => {
                    setCycle(value);
                    setHoverTime(null);
                  }}
                >
                  {value === 'long'
                    ? t('common.shared.quotaProjection.cycleLong')
                    : t('common.shared.quotaProjection.cycleShort')}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm quota-outlook__collapse"
            aria-expanded={!collapsed}
            onClick={toggleCollapsed}
            title={collapsed ? t('common.expand') : t('common.collapse')}
            aria-label={collapsed ? t('common.expand') : t('common.collapse')}
          >
            {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          <ul className="quota-outlook__legend">
            {projection.series.map((series) => {
              const hidden = hiddenIds.includes(series.id);
              return (
                <li key={series.id}>
                  <button
                    type="button"
                    className={`quota-outlook__legend-item${hidden ? ' is-hidden' : ''}`}
                    data-color={colorIndexById.get(series.id)}
                    aria-pressed={!hidden}
                    aria-label={t('common.shared.quotaProjection.seriesToggle', { name: series.label })}
                    onClick={() => toggleSeries(series.id)}
                  >
                    <span className="quota-outlook__swatch" aria-hidden="true" />
                    <span className="quota-outlook__legend-name">
                      {series.label} <span className="quota-outlook__count">({series.accountCount})</span>
                    </span>
                    <span className="quota-outlook__legend-value">{formatPercent(series.points[0].percent)}</span>
                    <span className="quota-outlook__legend-full">{describeFull(series)}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div ref={wrapRef} className="quota-outlook__chart-wrap">
            {width > 0 && (
              <svg
                className="quota-outlook__chart"
                width={width}
                height={CHART_HEIGHT}
                viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
                role="img"
                aria-label={`${t('common.shared.quotaProjection.chartLabel')}. ${chartSummary}`}
              >
                {[0, 25, 50, 75, 100].map((value) => (
                  <g key={value}>
                    <line
                      className={value === 0 ? 'quota-outlook__baseline' : 'quota-outlook__grid'}
                      x1={PLOT.left}
                      x2={PLOT.left + plotWidth}
                      y1={yOf(value)}
                      y2={yOf(value)}
                    />
                    <text className="quota-outlook__axis" x={PLOT.left - 8} y={yOf(value) + 3.5} textAnchor="end">
                      {value}%
                    </text>
                  </g>
                ))}
                <text className="quota-outlook__axis is-now" x={PLOT.left} y={CHART_HEIGHT - 8} textAnchor="start">
                  {t('common.shared.quotaProjection.now')}
                </text>
                {xTicks.map((tick) => (
                  <text key={tick} className="quota-outlook__axis" x={xOf(tick)} y={CHART_HEIGHT - 8} textAnchor="middle">
                    {formatTick(tick)}
                  </text>
                ))}

                {resetMarkers.map((reset, index) => (
                  <line
                    key={`${reset.seriesId}-${reset.timeMs}-${index}`}
                    className="quota-outlook__reset"
                    data-color={colorIndexById.get(reset.seriesId)}
                    x1={xOf(reset.timeMs)}
                    x2={xOf(reset.timeMs)}
                    y1={bottomY}
                    y2={bottomY + 5}
                  />
                ))}

                {visibleSeries.map((series) => {
                  const line = stepPath(series);
                  return (
                    <g key={series.id} className="quota-outlook__series" data-color={colorIndexById.get(series.id)}>
                      <path className="quota-outlook__area" d={`${line} V ${bottomY} H ${PLOT.left} Z`} />
                      <path className="quota-outlook__line" d={line} />
                    </g>
                  );
                })}

                {hoverX != null && hoverTime != null && (
                  <g pointerEvents="none">
                    <line className="quota-outlook__hover-line" x1={hoverX} x2={hoverX} y1={PLOT.top} y2={bottomY} />
                    {visibleSeries.map((series) => (
                      <circle
                        key={series.id}
                        className="quota-outlook__hover-dot"
                        data-color={colorIndexById.get(series.id)}
                        cx={hoverX}
                        cy={yOf(projectionValueAt(series, hoverTime).percent)}
                        r={4}
                      />
                    ))}
                  </g>
                )}

                <rect
                  className="quota-outlook__hit"
                  x={PLOT.left}
                  y={PLOT.top}
                  width={plotWidth}
                  height={plotHeight}
                  onPointerMove={handlePointerMove}
                  onPointerLeave={() => setHoverTime(null)}
                />
              </svg>
            )}

            {visibleSeries.length === 0 && (
              <div className="quota-outlook__empty" role="status">
                {t('common.shared.quotaProjection.allHidden')}
              </div>
            )}

            {hoverTime != null && visibleSeries.length > 0 && (
              <div className="quota-outlook__tooltip" role="status" style={tooltipStyle}>
                <div className="quota-outlook__tooltip-time">{formatMoment(hoverTime)}</div>
                {visibleSeries.map((series) => {
                  const value = projectionValueAt(series, hoverTime);
                  return (
                    <div key={series.id} className="quota-outlook__tooltip-row" data-color={colorIndexById.get(series.id)}>
                      <span className="quota-outlook__swatch" aria-hidden="true" />
                      <span className="quota-outlook__tooltip-name">{series.label}</span>
                      <strong>{formatPercent(value.percent)}</strong>
                      <span className="quota-outlook__tooltip-sub">
                        {t('common.shared.quotaProjection.accountsLeft', {
                          left: formatAccounts(value.accountsLeft),
                          total: series.accountCount,
                        })}
                      </span>
                    </div>
                  );
                })}
                {hoverResets.length > 0 && (
                  <div className="quota-outlook__tooltip-resets">
                    <div className="quota-outlook__tooltip-heading">{t('common.shared.quotaProjection.resetsNear')}</div>
                    {hoverResets.slice(0, 6).map((reset, index) => (
                      <div key={`${reset.seriesId}-${index}`} className="quota-outlook__tooltip-reset" data-color={colorIndexById.get(reset.seriesId)}>
                        <span className="quota-outlook__swatch" aria-hidden="true" />
                        <span className="quota-outlook__tooltip-name">
                          {maskSensitiveValue(reset.accountName, privacyMode)}
                        </span>
                        <span className="quota-outlook__gain">+{Math.round(reset.gainPercent)}%</span>
                      </div>
                    ))}
                    {hoverResets.length > 6 && (
                      <div className="quota-outlook__tooltip-sub">+{hoverResets.length - 6}</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
