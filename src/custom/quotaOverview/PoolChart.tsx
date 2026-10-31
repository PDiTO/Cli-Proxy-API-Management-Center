/**
 * Pool chart: one provider's pooled weekly quota, recorded and projected.
 *
 * Hand-drawn SVG in pixel space (measured width), so text and strokes keep
 * their size at any card width. All numbers come from poolForecast.ts.
 */

import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { getTypeLabel } from '@/features/authFiles/constants';
import type { QuotaProviderType } from '@/features/quota/providers/types';
import type { ResolvedTheme } from '@/types';
import { formatCountdown, formatShortDate, maskEmails } from './model';
import {
  burnRate,
  drainAt,
  projectPool,
  recordedDrain,
  recordedSeries,
  seriesValuesAt,
  sumValues,
  type DrainStep,
  type JumpMark,
  type PoolAccount,
  type RoutingMode,
  type SeriesPoint,
} from './poolForecast';
import { ProviderIcon } from './ProviderIcon';
import styles from './PoolChart.module.scss';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Stats look this far ahead, whatever the visible range. */
export const FORECAST_HORIZON_MS = 14 * DAY_MS;

export const CHART_MODES = ['remaining', 'drain'] as const;
export type ChartMode = (typeof CHART_MODES)[number];
export const BURN_WINDOWS = [1, 3, 6] as const;
export type BurnWindow = (typeof BURN_WINDOWS)[number];
export const FUTURE_USAGE = ['current', 'week', 'half', 'double', 'none'] as const;
export type FutureUsage = (typeof FUTURE_USAGE)[number];

const HEIGHT = 300;
const MARGIN = { top: 34, right: 14, bottom: 46, left: 56 };
const MIN_JUMP_LABEL = 3;

/** Provider line colors, light and dark steps. Text never uses these. */
const PROVIDER_COLORS: Partial<Record<QuotaProviderType, [string, string]>> = {
  claude: ['#d4693f', '#e07a52'],
  codex: ['#2a78d6', '#5598e7'],
  antigravity: ['#1baf7a', '#199e70'],
  kimi: ['#6250d6', '#9085e9'],
  xai: ['#52514e', '#c3c2b7'],
  devin: ['#008300', '#2fa82f'],
  meta: ['#256abf', '#3987e5'],
};
const FALLBACK_COLOR: [string, string] = ['#52514e', '#c3c2b7'];

const pick = ([light, dark]: [string, string], theme: ResolvedTheme) =>
  theme === 'dark' ? dark : light;

const formatWhen = (ms: number, locale: string) =>
  new Date(ms).toLocaleString(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

const formatRate = (rate: number) => (rate < 10 ? rate.toFixed(1) : String(Math.round(rate)));

/** 1, 2 or 5 times a power of ten, at least `value`. */
const niceCeil = (value: number) => {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((m) => m * magnitude >= value) ?? 10;
  return step * magnitude;
};

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export interface PoolChartProps {
  provider: QuotaProviderType;
  /** Loaded credentials in routing order. */
  accounts: PoolAccount[];
  credentialCount: number;
  nowMs: number;
  rangeStartMs: number;
  rangeEndMs: number;
  mode: ChartMode;
  burnHours: BurnWindow;
  futureUsage: FutureUsage;
  routing: RoutingMode;
  hideEmails: boolean;
  resolvedTheme: ResolvedTheme;
}

export function PoolChart({
  provider,
  accounts,
  credentialCount,
  nowMs,
  rangeStartMs,
  rangeEndMs,
  mode,
  burnHours,
  futureUsage,
  routing,
  hideEmails,
  resolvedTheme,
}: PoolChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const providerLabel = getTypeLabel(t, provider);
  const notLoaded = credentialCount - accounts.length;
  const labels = useMemo(
    () => accounts.map((account) => (hideEmails ? maskEmails(account.label) : account.label)),
    [accounts, hideEmails]
  );

  const total = accounts.length * 100;
  const poolRemaining = sumValues(accounts.map((account) => account.remaining));

  const recorded = useMemo(() => recordedSeries(accounts, nowMs), [accounts, nowMs]);
  const burn = useMemo(() => burnRate(accounts, nowMs, burnHours), [accounts, nowMs, burnHours]);
  const weekBurn = useMemo(
    () => (futureUsage === 'week' ? burnRate(accounts, nowMs, 168) : null),
    [accounts, nowMs, futureUsage]
  );
  const projectedBurn =
    futureUsage === 'none'
      ? 0
      : futureUsage === 'week'
        ? (weekBurn ?? 0)
        : (burn ?? 0) * (futureUsage === 'half' ? 0.5 : futureUsage === 'double' ? 2 : 1);
  const horizonMs = nowMs + FORECAST_HORIZON_MS;
  const projection = useMemo(
    () =>
      projectPool({
        accounts,
        nowMs,
        untilMs: Math.max(horizonMs, rangeEndMs),
        burnPerHour: projectedBurn,
        mode: routing,
      }),
    [accounts, nowMs, horizonMs, rangeEndMs, projectedBurn, routing]
  );
  const drainRecorded = useMemo(
    () => (mode === 'drain' ? recordedDrain(accounts, nowMs) : []),
    [accounts, mode, nowMs]
  );

  /* ---------- stats ---------- */

  const horizonDate = formatShortDate(horizonMs, locale);
  const within = (ms: number | null | undefined): ms is number =>
    typeof ms === 'number' && ms <= horizonMs;
  const poolEmptyText = within(projection.poolEmptyMs)
    ? t('pd_overview.in_time', { time: formatCountdown(projection.poolEmptyMs, nowMs) })
    : t('pd_overview.not_by', { date: horizonDate });
  const firstEmpty = projection.firstEmpty;
  const firstEmptyText =
    firstEmpty && within(firstEmpty.t)
      ? t('pd_overview.named_in', {
          name: labels[firstEmpty.index],
          time: formatCountdown(firstEmpty.t, nowMs),
        })
      : t('pd_overview.none_by', { date: horizonDate });
  const nextReset = projection.nextReset;

  /* ---------- geometry ---------- */

  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const span = rangeEndMs - rangeStartMs;
  const x = (ms: number) => MARGIN.left + ((ms - rangeStartMs) / span) * plotW;
  const timeAt = (px: number) => rangeStartMs + ((px - MARGIN.left) / plotW) * span;

  const drainMax = useMemo(() => {
    if (mode !== 'drain') return 1;
    const visible = (steps: DrainStep[]) => steps.map((step) => step.rate);
    return niceCeil(Math.max(0, ...visible(drainRecorded), ...visible(projection.drain)) * 1.15);
  }, [drainRecorded, mode, projection.drain]);
  const yMax = mode === 'drain' ? drainMax : Math.max(total, 100);
  const y = (value: number) => MARGIN.top + plotH - (value / yMax) * plotH;
  const baseline = MARGIN.top + plotH;

  const color = pick(PROVIDER_COLORS[provider] ?? FALLBACK_COLOR, resolvedTheme);
  const uid = useId().replace(/:/g, '');

  /** The pooled line: accounts summed at each point. */
  const linePath = (points: readonly SeriesPoint[]) =>
    points
      .map(
        (point, index) =>
          `${index === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${y(sumValues(point.values)).toFixed(1)}`
      )
      .join('');

  const stepPath = (steps: readonly DrainStep[], endMs: number) =>
    steps
      .map((step, index) => {
        const nextT = steps[index + 1]?.t ?? endMs;
        const yy = y(step.rate).toFixed(1);
        return `${index === 0 ? 'M' : 'L'}${x(step.t).toFixed(1)},${yy}L${x(nextT).toFixed(1)},${yy}`;
      })
      .join('');

  const areaUnder = (line: string, startMs: number, endMs: number) =>
    line ? `${line}L${x(endMs).toFixed(1)},${baseline}L${x(startMs).toFixed(1)},${baseline}Z` : '';

  /* ---------- ticks and labels ---------- */

  const yTicks = [0, yMax / 2, yMax];
  const days = useMemo(() => {
    const out: number[] = [];
    const d = new Date(rangeStartMs);
    d.setHours(0, 0, 0, 0);
    for (let ms = d.getTime(); ms < rangeEndMs;) {
      if (ms >= rangeStartMs) out.push(ms);
      d.setDate(d.getDate() + 1);
      ms = d.getTime();
    }
    return out;
  }, [rangeStartMs, rangeEndMs]);
  const dayStep = plotW / Math.max(1, days.length) < 44 ? 2 : 1;
  const nowVisible = nowMs >= rangeStartMs && nowMs <= rangeEndMs;

  const jumpLabels = useMemo(() => {
    if (mode !== 'remaining' || plotW <= 0) return [];
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    if (nowVisible) {
      const nx = x(nowMs);
      placed.push({ x0: nx - 18, x1: nx + 18, y0: 2, y1: 18 });
    }
    const overlaps = (box: (typeof placed)[number]) =>
      placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0);
    const marks: { key: string; x: number; y: number; text: string }[] = [];
    const candidates: { jump: JumpMark; points: readonly SeriesPoint[] }[] = [
      ...recorded.jumps.map((jump) => ({ jump, points: recorded.points })),
      ...projection.jumps.map((jump) => ({ jump, points: projection.points })),
    ];
    for (const { jump, points } of candidates) {
      if (jump.gain < MIN_JUMP_LABEL || jump.t < rangeStartMs || jump.t > rangeEndMs) continue;
      const after = seriesValuesAt(points, jump.t);
      if (!after) continue;
      const jx = x(jump.t);
      const top = y(sumValues(after));
      const text = `+${Math.round(jump.gain)}%`;
      const w = text.length * 7 + 4;
      for (const ty of [top - 8, top + 20]) {
        const box = { x0: jx - w / 2, x1: jx + w / 2, y0: ty - 12, y1: ty + 2 };
        if (ty < 14 || ty > baseline - 4 || overlaps(box)) continue;
        placed.push(box);
        marks.push({ key: `${jump.t}`, x: jx, y: ty, text });
        break;
      }
    }
    return marks;
    // x and y close over the values listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, plotW, nowVisible, nowMs, recorded, projection, rangeStartMs, rangeEndMs, yMax]);

  /* ---------- hover ---------- */

  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const clampToRange = (ms: number) => Math.min(rangeEndMs, Math.max(rangeStartMs, ms));
  const onPointerMove = (event: PointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!rect) return;
    setHoverMs(clampToRange(timeAt(event.clientX - rect.left)));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? DAY_MS : HOUR_MS;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      setHoverMs((value) => clampToRange((value ?? nowMs) + direction * step));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setHoverMs(clampToRange(nowMs));
    } else if (event.key === 'Escape') {
      setHoverMs(null);
    }
  };

  const hover = useMemo(() => {
    if (hoverMs === null) return null;
    const future = hoverMs > nowMs;
    if (mode === 'drain') {
      const rate = drainAt(future ? projection.drain : drainRecorded, hoverMs);
      return rate === null
        ? { ms: hoverMs, total: null, values: null }
        : { ms: hoverMs, total: rate, values: null };
    }
    const values = seriesValuesAt(future ? projection.points : recorded.points, hoverMs);
    return { ms: hoverMs, total: values ? sumValues(values) : null, values };
  }, [drainRecorded, hoverMs, mode, nowMs, projection, recorded.points]);

  const chartLabel = t('pd_overview.chart_label', {
    provider: providerLabel,
    remaining: Math.round(poolRemaining),
    total,
  });

  /* ---------- render ---------- */

  const recordedLine = mode === 'remaining' ? linePath(recorded.points) : '';
  const projectedLine = mode === 'remaining' ? linePath(projection.points) : '';
  const recordedStart = recorded.points[0]?.t ?? nowMs;

  return (
    <section className={styles.card} style={{ '--pool-color': color } as CSSProperties}>
      <header className={styles.head}>
        <ProviderIcon provider={provider} resolvedTheme={resolvedTheme} />
        <h2 className={styles.name}>{providerLabel}</h2>
        <span className={styles.muted}>
          {t('pd_overview.accounts', { count: credentialCount })}
          {notLoaded > 0 && ` · ${t('pd_overview.not_loaded', { count: notLoaded })}`}
        </span>
      </header>

      {accounts.length === 0 ? (
        <p className={styles.muted}>{t('pd_overview.not_loaded_row')}</p>
      ) : (
        <>
          <div className={styles.stats}>
            <div className={styles.hero}>
              <span className={styles.heroValue}>{Math.round(poolRemaining)}%</span>
              <span className={styles.muted}>{t('pd_overview.of_total', { total })}</span>
            </div>
            <dl className={styles.statList}>
              <div>
                <dt>{t('pd_overview.pool_empty')}</dt>
                <dd>{poolEmptyText}</dd>
              </div>
              <div>
                <dt>{t('pd_overview.first_empty')}</dt>
                <dd>{firstEmptyText}</dd>
              </div>
              <div>
                <dt>{t('pd_overview.next_reset')}</dt>
                <dd>
                  {nextReset && within(nextReset.t) ? (
                    <>
                      <strong>+{Math.round(nextReset.gain)}%</strong>{' '}
                      {formatWhen(nextReset.t, locale)}
                    </>
                  ) : (
                    '–'
                  )}
                </dd>
              </div>
              <div>
                <dt>{t('pd_overview.burn_label', { hours: burnHours })}</dt>
                <dd title={burn === null ? t('pd_overview.history_hint') : undefined}>
                  {burn === null
                    ? t('pd_overview.no_burn_data')
                    : t('pd_overview.rate_value', { value: formatRate(burn) })}
                </dd>
              </div>
            </dl>
          </div>

          <div
            ref={wrapRef}
            className={styles.plot}
            tabIndex={0}
            role="group"
            aria-label={chartLabel}
            onKeyDown={onKeyDown}
            onFocus={() => setHoverMs((value) => value ?? clampToRange(nowMs))}
            onBlur={() => setHoverMs(null)}
          >
            {width > 0 && (
              <svg width={width} height={HEIGHT} aria-hidden="true" className={styles.svg}>
                <defs>
                  <clipPath id={`${uid}-clip`}>
                    <rect x={MARGIN.left} y={0} width={plotW} height={baseline} />
                  </clipPath>
                  <linearGradient id={`${uid}-fill`} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.32} />
                    <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                  </linearGradient>
                </defs>

                {yTicks.map((tick) => (
                  <g key={tick}>
                    <line
                      className={tick === 0 ? styles.axis : styles.grid}
                      x1={MARGIN.left}
                      x2={MARGIN.left + plotW}
                      y1={y(tick)}
                      y2={y(tick)}
                    />
                    <text
                      className={styles.tick}
                      x={MARGIN.left - 10}
                      y={y(tick) + 4}
                      textAnchor="end"
                    >
                      {tick === 0
                        ? '0'
                        : mode === 'drain'
                          ? `${Number.isInteger(tick) ? tick : tick.toFixed(1)}%/h`
                          : `${Math.round(tick)}%`}
                    </text>
                  </g>
                ))}

                {days.map((day, index) => (
                  <g key={day}>
                    <line
                      className={styles.grid}
                      x1={x(day)}
                      x2={x(day)}
                      y1={MARGIN.top}
                      y2={baseline}
                    />
                    {index % dayStep === 0 && x(day + DAY_MS / 2) < MARGIN.left + plotW && (
                      <text
                        className={styles.tick}
                        x={x(day + DAY_MS / 2)}
                        y={baseline + 18}
                        textAnchor="middle"
                      >
                        <tspan>
                          {new Date(day).toLocaleDateString(locale, { weekday: 'short' })}
                        </tspan>
                        <tspan x={x(day + DAY_MS / 2)} dy={15}>
                          {new Date(day).getDate()}
                        </tspan>
                      </text>
                    )}
                  </g>
                ))}

                <g clipPath={`url(#${uid}-clip)`}>
                  {mode === 'drain' ? (
                    <>
                      <path
                        d={areaUnder(
                          stepPath(drainRecorded, nowMs),
                          drainRecorded[0]?.t ?? nowMs,
                          nowMs
                        )}
                        fill={`url(#${uid}-fill)`}
                      />
                      <path className={styles.line} d={stepPath(drainRecorded, nowMs)} />
                      <path
                        className={`${styles.line} ${styles.dashed}`}
                        d={stepPath(projection.drain, Math.max(horizonMs, rangeEndMs))}
                      />
                    </>
                  ) : (
                    <>
                      <path
                        d={areaUnder(recordedLine, recordedStart, nowMs)}
                        fill={`url(#${uid}-fill)`}
                      />
                      <path
                        d={areaUnder(
                          projectedLine,
                          nowMs,
                          projection.points[projection.points.length - 1]?.t ?? nowMs
                        )}
                        fill={`url(#${uid}-fill)`}
                        opacity={0.55}
                      />
                      <path className={styles.line} d={recordedLine} />
                      <path className={`${styles.line} ${styles.dashed}`} d={projectedLine} />
                    </>
                  )}
                </g>

                {jumpLabels.map((mark) => (
                  <text
                    key={mark.key}
                    className={styles.jump}
                    x={mark.x}
                    y={mark.y}
                    textAnchor="middle"
                  >
                    {mark.text}
                  </text>
                ))}

                {nowVisible && (
                  <g>
                    <line
                      className={styles.nowLine}
                      x1={x(nowMs)}
                      x2={x(nowMs)}
                      y1={MARGIN.top - 8}
                      y2={baseline + 32}
                    />
                    <text className={styles.tick} x={x(nowMs)} y={14} textAnchor="middle">
                      {t('pd_overview.now')}
                    </text>
                    {mode === 'remaining' && (
                      <circle className={styles.dot} cx={x(nowMs)} cy={y(poolRemaining)} r={4.5} />
                    )}
                  </g>
                )}

                {hover && (
                  <g>
                    <line
                      className={styles.hoverLine}
                      x1={x(hover.ms)}
                      x2={x(hover.ms)}
                      y1={MARGIN.top}
                      y2={baseline}
                    />
                    {hover.total !== null && (
                      <circle className={styles.dot} cx={x(hover.ms)} cy={y(hover.total)} r={4.5} />
                    )}
                  </g>
                )}

                <rect
                  x={MARGIN.left}
                  y={0}
                  width={plotW}
                  height={baseline}
                  fill="transparent"
                  onPointerMove={onPointerMove}
                  onPointerLeave={() => setHoverMs(null)}
                />
              </svg>
            )}

            {hover && (
              <div
                className={styles.tooltip}
                style={
                  x(hover.ms) > width * 0.6
                    ? { right: width - x(hover.ms) + 12 }
                    : { left: x(hover.ms) + 12 }
                }
                role="status"
              >
                <div>
                  <span className={styles.muted}>{formatWhen(hover.ms, locale)}</span>
                  {' · '}
                  {hover.total === null ? (
                    <span className={styles.muted}>{t('pd_overview.no_history')}</span>
                  ) : mode === 'drain' ? (
                    <strong>
                      {t('pd_overview.rate_value', { value: formatRate(hover.total) })}
                    </strong>
                  ) : (
                    <strong>
                      {t('pd_overview.left_value', { value: Math.round(hover.total) })}
                    </strong>
                  )}
                </div>
              </div>
            )}
          </div>

          <footer className={styles.legend}>
            <span className={styles.legendTitle}>
              {mode === 'drain' ? t('pd_overview.mode_drain') : t('pd_overview.pool')}
            </span>
            <span className={styles.legendItem}>
              <span className={styles.legendLine} aria-hidden="true" />
              {t('pd_overview.recorded')}
            </span>
            <span className={styles.legendItem}>
              <span className={`${styles.legendLine} ${styles.legendDashed}`} aria-hidden="true" />
              {t('pd_overview.projected')}
            </span>
            {recorded.points.length === 0 && (
              <span className={styles.legendNote}>{t('pd_overview.history_hint')}</span>
            )}
          </footer>
        </>
      )}
    </section>
  );
}
