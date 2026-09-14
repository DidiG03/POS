import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ReviewDTO,
  ReviewGranularity,
  ReviewRangeInput,
  ReviewSummaryDTO,
} from '@shared/ipc';
import {
  formatMoneyCompact,
  formatNumberMaxDecimals,
} from '../../utils/format';
import { EmptyState } from '../../components/ui/Surface';
import { Field, Input, Select, Switch } from '../../components/ui/Field';
import { Badge } from '../../components/ui/Badge';
import { Table, TableFrame, Td, Th } from '../../components/ui/Table';
import { cn } from '../../components/ui/cn';
import { useLicenseCapabilities } from '../../stores/licenseCapabilities';
import {
  HEATMAP_DAYS_MON_FIRST,
  heatmapHasOrders,
} from '@shared/reviewHeatmap';
import { OrdersByTimeChart, OrdersByTimeLegend } from './OrdersByTimeChart';
import { PageSpinner } from '../../components/PageSpinner';
import { reportAppError } from '../../utils/reportAppError';

// ---------------------------------------------------------------------
// Date helpers — all comparisons are computed in the operator's local
// timezone, which is also where the POS records ticket timestamps.
// ---------------------------------------------------------------------

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

function startOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 0, 1, 0, 0, 0, 0);
}

function endOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 11, 31, 23, 59, 59, 999);
}

function addMonths(d: Date, n: number): Date {
  const out = new Date(d);
  out.setMonth(out.getMonth() + n);
  return out;
}

function addYears(d: Date, n: number): Date {
  const out = new Date(d);
  out.setFullYear(out.getFullYear() + n);
  return out;
}

function previousMonthToSameElapsedDay(d: Date): Period {
  const currentStart = startOfMonth(d);
  const elapsedDays = Math.max(
    0,
    Math.floor((startOfDay(d).getTime() - currentStart.getTime()) / 86400000),
  );
  const prev = addMonths(d, -1);
  const start = startOfMonth(prev);
  const end = endOfDay(addDays(start, elapsedDays));
  const cap = endOfMonth(prev);
  return { start, end: end.getTime() > cap.getTime() ? cap : end };
}

function previousYearToSameElapsedDay(d: Date): Period {
  const start = startOfYear(addYears(d, -1));
  const candidate = addYears(d, -1);
  const end = endOfDay(candidate);
  const cap = endOfYear(candidate);
  return { start, end: end.getTime() > cap.getTime() ? cap : end };
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function toIsoDate(d: Date): string {
  // YYYY-MM-DD — the value <input type="date"> wants.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fromIsoDate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

// ---------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------

type PresetId =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'thisMonth'
  | 'lastMonth'
  | 'thisYear'
  | 'lastYear'
  | 'custom';

interface Period {
  start: Date;
  end: Date;
}

interface Preset {
  id: PresetId;
  current(): Period;
  compare(): Period;
  granularity: ReviewGranularity;
}

function presetLabel(id: PresetId, t: (key: string) => string): string {
  const keys: Record<Exclude<PresetId, 'custom'>, string> = {
    today: 'adminReview.presetToday',
    yesterday: 'adminReview.presetYesterday',
    last7: 'adminReview.presetLast7',
    last30: 'adminReview.presetLast30',
    thisMonth: 'adminReview.presetThisMonth',
    lastMonth: 'adminReview.presetLastMonth',
    thisYear: 'adminReview.presetThisYear',
    lastYear: 'adminReview.presetLastYear',
  };
  return id === 'custom' ? t('adminReview.customRange') : t(keys[id]);
}

const PRESETS: Preset[] = [
  {
    id: 'today',
    current: () => ({
      start: startOfDay(new Date()),
      end: endOfDay(new Date()),
    }),
    compare: () => {
      const y = addDays(new Date(), -1);
      return { start: startOfDay(y), end: endOfDay(y) };
    },
    granularity: 'day',
  },
  {
    id: 'yesterday',
    current: () => {
      const y = addDays(new Date(), -1);
      return { start: startOfDay(y), end: endOfDay(y) };
    },
    compare: () => {
      const d = addDays(new Date(), -2);
      return { start: startOfDay(d), end: endOfDay(d) };
    },
    granularity: 'day',
  },
  {
    id: 'last7',
    current: () => ({
      start: startOfDay(addDays(new Date(), -6)),
      end: endOfDay(new Date()),
    }),
    compare: () => ({
      start: startOfDay(addDays(new Date(), -13)),
      end: endOfDay(addDays(new Date(), -7)),
    }),
    granularity: 'day',
  },
  {
    id: 'last30',
    current: () => ({
      start: startOfDay(addDays(new Date(), -29)),
      end: endOfDay(new Date()),
    }),
    compare: () => ({
      start: startOfDay(addDays(new Date(), -59)),
      end: endOfDay(addDays(new Date(), -30)),
    }),
    granularity: 'day',
  },
  {
    id: 'thisMonth',
    current: () => ({
      start: startOfMonth(new Date()),
      end: endOfDay(new Date()),
    }),
    compare: () => {
      return previousMonthToSameElapsedDay(new Date());
    },
    granularity: 'day',
  },
  {
    id: 'lastMonth',
    current: () => {
      const prev = addMonths(new Date(), -1);
      return { start: startOfMonth(prev), end: endOfMonth(prev) };
    },
    compare: () => {
      const prev2 = addMonths(new Date(), -2);
      return { start: startOfMonth(prev2), end: endOfMonth(prev2) };
    },
    granularity: 'day',
  },
  {
    id: 'thisYear',
    current: () => ({
      start: startOfYear(new Date()),
      end: endOfDay(new Date()),
    }),
    compare: () => {
      return previousYearToSameElapsedDay(new Date());
    },
    granularity: 'month',
  },
  {
    id: 'lastYear',
    current: () => {
      const ly = addYears(new Date(), -1);
      return { start: startOfYear(ly), end: endOfYear(ly) };
    },
    compare: () => {
      const py = addYears(new Date(), -2);
      return { start: startOfYear(py), end: endOfYear(py) };
    },
    granularity: 'month',
  },
];

// ---------------------------------------------------------------------
// Tiny SVG charts. Inline so we don't pull in a charting dependency.
// ---------------------------------------------------------------------

function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(n)));
  const f = n / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * exp;
}

interface LineSeries {
  label: string;
  color: string;
  points: { x: number; y: number; tooltip: string }[];
}

function xPos(
  x: number,
  xMin: number,
  xRange: number,
  paddingLeft: number,
  innerW: number,
): number {
  return paddingLeft + ((x - xMin) / xRange) * innerW;
}

/** Align current vs compare on calendar time when ranges overlap, else overlay by period offset. */
function alignReviewChart(
  current: Array<{ label: string; bucketIso: string }>,
  compare: Array<{ label: string; bucketIso: string }> | null | undefined,
): {
  labels: { x: number; label: string }[];
  currentX: number[];
  compareX: number[];
} {
  const cur = current || [];
  const cmp = compare || [];
  if (cmp.length === 0) {
    return {
      labels: cur.map((p, i) => ({ x: i, label: p.label })),
      currentX: cur.map((_, i) => i),
      compareX: [],
    };
  }
  const c0 = Date.parse(cur[0]?.bucketIso || '');
  const c1 = Date.parse(cur[cur.length - 1]?.bucketIso || '');
  const p0 = Date.parse(cmp[0]?.bucketIso || '');
  const p1 = Date.parse(cmp[cmp.length - 1]?.bucketIso || '');
  const overlap =
    Number.isFinite(c0) &&
    Number.isFinite(c1) &&
    Number.isFinite(p0) &&
    Number.isFinite(p1) &&
    c0 <= p1 &&
    p0 <= c1;
  if (overlap) {
    const byIso = new Map<string, string>();
    for (const p of cmp) byIso.set(p.bucketIso, p.label);
    for (const p of cur) byIso.set(p.bucketIso, p.label);
    const isos = [...byIso.keys()].sort(
      (a, b) => Date.parse(a) - Date.parse(b),
    );
    const index = new Map(isos.map((iso, i) => [iso, i]));
    return {
      labels: isos.map((iso, i) => ({
        x: i,
        label: byIso.get(iso) || iso,
      })),
      currentX: cur.map((p) => index.get(p.bucketIso) ?? 0),
      compareX: cmp.map((p) => index.get(p.bucketIso) ?? 0),
    };
  }
  const n = Math.max(cur.length - 1, 1);
  return {
    labels: cur.map((p, i) => ({ x: i, label: p.label })),
    currentX: cur.map((_, i) => i),
    compareX: cmp.map((_, i) =>
      cmp.length <= 1 ? 0 : (i * n) / Math.max(1, cmp.length - 1),
    ),
  };
}

function LineChart({
  series,
  height = 240,
  yLabel,
  xLabels,
}: {
  series: LineSeries[];
  height?: number;
  yLabel?: string;
  xLabels: { x: number; label: string }[];
}) {
  const padding = { top: 16, right: 16, bottom: 32, left: 56 };
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number>(640);
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(320, Math.floor(entry.contentRect.width));
        setWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const innerW = Math.max(80, width - padding.left - padding.right);
  const innerH = height - padding.top - padding.bottom;

  const allY = series.flatMap((s) => s.points.map((p) => p.y));
  const yMaxRaw = Math.max(0, ...allY);
  const yMax = yMaxRaw > 0 ? niceCeil(yMaxRaw) : 1;

  const allX = [
    ...series.flatMap((s) => s.points.map((p) => p.x)),
    ...xLabels.map((l) => l.x),
  ];
  const xMin = allX.length ? Math.min(...allX) : 0;
  const xMax = allX.length ? Math.max(...allX) : 1;
  const xRange = Math.max(1e-6, xMax - xMin);
  const toX = (x: number) => xPos(x, xMin, xRange, padding.left, innerW);

  const yTicks = 4;
  const ticks = Array.from(
    { length: yTicks + 1 },
    (_, i) => (yMax * i) / yTicks,
  );

  const showEvery = Math.max(1, Math.ceil(xLabels.length / 8));

  const [hover, setHover] = useState<{
    seriesIdx: number;
    pointIdx: number;
    x: number;
    y: number;
    tooltip: string;
    color: string;
  } | null>(null);

  return (
    <div ref={containerRef} className="w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={yLabel || 'Chart'}
        onMouseLeave={() => setHover(null)}
      >
        {/* y-axis grid + labels */}
        {ticks.map((t, i) => {
          const y = padding.top + innerH - (t / yMax) * innerH;
          return (
            <g key={i}>
              <line
                x1={padding.left}
                x2={padding.left + innerW}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeOpacity={i === 0 ? 0.35 : 0.12}
                strokeDasharray={i === 0 ? '0' : '3 3'}
              />
              <text
                x={padding.left - 6}
                y={y + 4}
                textAnchor="end"
                fontSize="10"
                fill="currentColor"
                opacity={0.7}
              >
                {t >= 1000 ? `${Math.round(t / 100) / 10}k` : Math.round(t)}
              </text>
            </g>
          );
        })}

        {/* series */}
        {series.map((s, sIdx) => {
          if (s.points.length === 0) return null;
          const path = s.points
            .map((p, i) => {
              const x = toX(p.x);
              const y = padding.top + innerH - (p.y / yMax) * innerH;
              return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
            })
            .join(' ');
          const lastX = toX(s.points[s.points.length - 1]?.x ?? xMin);
          const firstX = toX(s.points[0]?.x ?? xMin);
          const areaPath =
            sIdx === 0
              ? `${path} L ${lastX.toFixed(2)} ${(padding.top + innerH).toFixed(
                  2,
                )} L ${firstX.toFixed(2)} ${(padding.top + innerH).toFixed(
                  2,
                )} Z`
              : '';
          return (
            <g key={s.label}>
              {areaPath && (
                <path d={areaPath} fill={s.color} fillOpacity={0.12} />
              )}
              <path
                d={path}
                fill="none"
                stroke={s.color}
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {s.points.map((p, i) => {
                const x = toX(p.x);
                const y = padding.top + innerH - (p.y / yMax) * innerH;
                return (
                  <circle
                    key={i}
                    cx={x}
                    cy={y}
                    r={3}
                    fill={s.color}
                    onMouseEnter={() =>
                      setHover({
                        seriesIdx: sIdx,
                        pointIdx: i,
                        x,
                        y,
                        tooltip: p.tooltip,
                        color: s.color,
                      })
                    }
                  />
                );
              })}
            </g>
          );
        })}

        {/* x-axis labels */}
        {xLabels.map((tick, i) => {
          if (i % showEvery !== 0 && i !== xLabels.length - 1) return null;
          const x = toX(tick.x);
          return (
            <text
              key={`${tick.x}-${tick.label}`}
              x={x}
              y={padding.top + innerH + 16}
              textAnchor="middle"
              fontSize="10"
              fill="currentColor"
              opacity={0.7}
            >
              {tick.label}
            </text>
          );
        })}

        {hover && (
          <g pointerEvents="none">
            <line
              x1={hover.x}
              x2={hover.x}
              y1={padding.top}
              y2={padding.top + innerH}
              stroke="currentColor"
              strokeOpacity={0.3}
              strokeDasharray="2 3"
            />
            <circle
              cx={hover.x}
              cy={hover.y}
              r={5}
              fill={hover.color}
              stroke="white"
              strokeWidth={1.5}
            />
          </g>
        )}
      </svg>
      {hover && (
        <div className="text-xs mt-1 text-gray-300">{hover.tooltip}</div>
      )}
    </div>
  );
}

function BarChart({
  data,
  height = 160,
  format = (n) => String(Math.round(n)),
  color = '#60a5fa',
}: {
  data: { label: string; value: number; tooltip?: string }[];
  height?: number;
  format?: (n: number) => string;
  color?: string;
}) {
  const padding = { top: 8, right: 8, bottom: 24, left: 32 };
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number>(480);
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(240, Math.floor(entry.contentRect.width));
        setWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const innerW = Math.max(40, width - padding.left - padding.right);
  const innerH = height - padding.top - padding.bottom;
  const max = Math.max(1, ...data.map((d) => d.value));
  const yMax = niceCeil(max);
  const barW = (innerW / Math.max(1, data.length)) * 0.7;
  const gap = (innerW / Math.max(1, data.length)) * 0.3;
  const showEvery = Math.max(1, Math.ceil(data.length / 12));

  return (
    <div ref={containerRef} className="w-full">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height}>
        <line
          x1={padding.left}
          x2={padding.left + innerW}
          y1={padding.top + innerH}
          y2={padding.top + innerH}
          stroke="currentColor"
          strokeOpacity={0.3}
        />
        {data.map((d, i) => {
          const x = padding.left + i * (barW + gap) + gap / 2;
          const h = (d.value / yMax) * innerH;
          const y = padding.top + innerH - h;
          return (
            <g key={i}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={Math.max(0, h)}
                fill={color}
                rx={2}
              >
                <title>{d.tooltip || `${d.label}: ${format(d.value)}`}</title>
              </rect>
              {i % showEvery === 0 && (
                <text
                  x={x + barW / 2}
                  y={padding.top + innerH + 14}
                  textAnchor="middle"
                  fontSize="10"
                  fill="currentColor"
                  opacity={0.7}
                >
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ShareBar({
  slices,
  format,
}: {
  slices: { id: string; label: string; value: number; color: string }[];
  format: (n: number) => string;
}) {
  const total = slices.reduce((n, s) => n + s.value, 0);
  const visible = slices.filter((s) => s.value > 0);
  return (
    <div>
      <div className="flex h-2.5 overflow-hidden rounded-sm bg-white/[0.06]">
        {total > 0
          ? visible.map((s) => (
              <div
                key={s.id}
                className="h-full min-w-0"
                style={{
                  width: `${(s.value / total) * 100}%`,
                  background: s.color,
                }}
                title={`${s.label}: ${format(s.value)}`}
              />
            ))
          : null}
      </div>
      <ul className="mt-3 space-y-1.5">
        {slices.map((s) => {
          const pct = total > 0 ? (s.value / total) * 100 : 0;
          return (
            <li
              key={s.id}
              className="flex items-baseline justify-between gap-3 text-[12px]"
            >
              <span className="flex min-w-0 items-center gap-2 text-gray-400">
                <span
                  className="size-2 shrink-0 rounded-sm"
                  style={{ background: s.color }}
                  aria-hidden
                />
                <span className="truncate">{s.label}</span>
              </span>
              <span className="shrink-0 tabular-nums text-gray-200">
                {format(s.value)}
                <span className="ml-2 text-gray-500">{pct.toFixed(1)}%</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RankChart({
  rows,
  format,
  color = '#60a5fa',
}: {
  rows: { label: string; value: number; hint?: string }[];
  format: (n: number) => string;
  color?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label} title={r.hint || `${r.label}: ${format(r.value)}`}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[12px]">
            <span className="min-w-0 truncate text-gray-300">{r.label}</span>
            <span className="shrink-0 tabular-nums text-gray-200">
              {format(r.value)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-sm bg-white/[0.06]">
            <div
              className="h-full rounded-sm"
              style={{
                width: `${(r.value / max) * 100}%`,
                background: color,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------------

function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(1)}%`;
}

function deltaFor(
  curr: number,
  prev: number | null | undefined,
): number | null {
  if (prev == null) return null;
  if (prev === 0) {
    if (curr === 0) return 0;
    return null; // undefined growth from a zero base
  }
  return (curr - prev) / Math.abs(prev);
}

function grossRevenueOf(summary: ReviewSummaryDTO | null | undefined): number {
  if (!summary) return 0;
  return summary.revenueGross ?? summary.revenueNet + summary.revenueVat;
}

function KpiCard({
  label,
  value,
  prev,
  delta,
  hint,
  showComparison = false,
}: {
  label: string;
  value: string;
  prev?: string | null;
  delta?: number | null;
  hint?: string;
  showComparison?: boolean;
}) {
  const { t } = useTranslation();
  const dir = delta == null ? 0 : delta > 0 ? 1 : delta < 0 ? -1 : 0;
  const arrow = dir > 0 ? '▲' : dir < 0 ? '▼' : '–';
  const bothZero = delta === 0 && (prev == null || prev === value);
  const quiet =
    value === '—' ||
    value === '0' ||
    /([^\d]|^)0([.,]00)?$/.test(String(value));
  return (
    <div className="admin-metric">
      <div className="admin-metric-label">{label}</div>
      <div className={cn('admin-metric-value', quiet && 'is-quiet')}>
        {value}
      </div>
      {showComparison && !bothZero ? (
        <div className="admin-metric-hint">
          {delta != null ? (
            <span
              className={cn(
                'tabular-nums',
                dir > 0 && 'text-emerald-400',
                dir < 0 && 'text-rose-400',
                dir === 0 && 'text-gray-500',
              )}
            >
              {arrow} {fmtPct(delta)}
            </span>
          ) : (
            <span>{t('adminReview.noComparison')}</span>
          )}
          {prev != null ? (
            <span> {t('adminReview.vsPrevious', { value: prev })}</span>
          ) : null}
        </div>
      ) : null}
      {hint ? <div className="admin-metric-hint">{hint}</div> : null}
    </div>
  );
}

function MetricGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="admin-kicker mb-3">{title}</h2>
      <div className="admin-metrics">{children}</div>
    </section>
  );
}

function Panel({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <h2 className="admin-kicker">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------

export default function AdminReviewPage() {
  const { t } = useTranslation();
  const hasTables = useLicenseCapabilities((s) => s.hasTables);
  const [presetId, setPresetId] = useState<PresetId>('thisMonth');
  const initialPreset = PRESETS.find((p) => p.id === 'thisMonth')!;
  const [granularity, setGranularity] = useState<ReviewGranularity>(
    initialPreset.granularity,
  );
  const [compareEnabled, setCompareEnabled] = useState(true);

  const [curStart, setCurStart] = useState<string>(
    toIsoDate(initialPreset.current().start),
  );
  const [curEnd, setCurEnd] = useState<string>(
    toIsoDate(initialPreset.current().end),
  );
  const [cmpStart, setCmpStart] = useState<string>(
    toIsoDate(initialPreset.compare().start),
  );
  const [cmpEnd, setCmpEnd] = useState<string>(
    toIsoDate(initialPreset.compare().end),
  );

  const [currency, setCurrency] = useState<string>('EUR');
  const [data, setData] = useState<ReviewDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  // Load currency once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await window.api.settings.get();
        if (!cancelled) {
          const cur = String((s as any)?.currency || '').trim();
          if (cur) setCurrency(cur);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyPreset = (id: PresetId) => {
    setPresetId(id);
    if (id === 'custom') return;
    const p = PRESETS.find((pp) => pp.id === id);
    if (!p) return;
    const c = p.current();
    const cmp = p.compare();
    setCurStart(toIsoDate(c.start));
    setCurEnd(toIsoDate(c.end));
    setCmpStart(toIsoDate(cmp.start));
    setCmpEnd(toIsoDate(cmp.end));
    setGranularity(p.granularity);
  };

  // Whenever any control changes, re-fetch. Earlier fetches are
  // discarded via a request token so we never display stale data.
  useEffect(() => {
    const startD = fromIsoDate(curStart);
    const endD = fromIsoDate(curEnd);
    if (!startD || !endD) return;
    const cmpStartD = compareEnabled ? fromIsoDate(cmpStart) : null;
    const cmpEndD = compareEnabled ? fromIsoDate(cmpEnd) : null;

    const req: ReviewRangeInput = {
      currentStartIso: startOfDay(startD).toISOString(),
      currentEndIso: endOfDay(endD).toISOString(),
      compareStartIso:
        cmpStartD != null ? startOfDay(cmpStartD).toISOString() : null,
      compareEndIso: cmpEndD != null ? endOfDay(cmpEndD).toISOString() : null,
      granularity,
    };

    const myReq = ++reqRef.current;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // The Review tab depends on a preload IPC that is only registered
        // when the app is launched fresh. Electron preload scripts do not
        // hot-reload; if the preload bundle is out of sync (e.g. after a
        // dev rebuild without restarting the window, or a partial deploy),
        // surface a clear, actionable message instead of a raw TypeError.
        const fn = (window.api as any)?.admin?.getReview;
        if (typeof fn !== 'function') {
          throw new Error(t('adminReview.unavailable'));
        }
        const res = await window.api.admin.getReview(req);
        if (myReq !== reqRef.current) return;
        setData(res);
      } catch (e: any) {
        if (myReq !== reqRef.current) return;
        setError(e?.message || t('adminReview.loadFailed'));
        reportAppError(e, {
          fallback: t('adminReview.loadFailed'),
          key: 'adminReview.load',
        });
      } finally {
        if (myReq === reqRef.current) setLoading(false);
      }
    })();
  }, [curStart, curEnd, cmpStart, cmpEnd, compareEnabled, granularity, t]);

  const fmtMoney = useMemo(
    () => (n: number) => formatMoneyCompact(currency, n),
    [currency],
  );
  const fmtNum = useMemo(
    () => (n: number) => formatNumberMaxDecimals(n, 1),
    [],
  );

  const summary = data?.current;
  const compare = data?.compare ?? null;
  const series = data?.series;
  const currentGross = grossRevenueOf(summary);
  const compareGross = grossRevenueOf(compare);

  const aligned = useMemo(
    () => alignReviewChart(series?.current || [], series?.compare),
    [series],
  );

  const chartLabels = aligned.labels;

  const weekdayNames = useMemo(
    () => [
      t('adminReview.weekdaySun'),
      t('adminReview.weekdayMon'),
      t('adminReview.weekdayTue'),
      t('adminReview.weekdayWed'),
      t('adminReview.weekdayThu'),
      t('adminReview.weekdayFri'),
      t('adminReview.weekdaySat'),
    ],
    [t],
  );

  const chartSeries = useMemo<LineSeries[]>(() => {
    if (!series) return [];
    const cur = series.current || [];
    const out: LineSeries[] = [
      {
        label: t('adminReview.current'),
        color: '#60a5fa',
        points: cur.map((p, i) => ({
          x: aligned.currentX[i] ?? i,
          y: p.revenue,
          tooltip: t('adminReview.chartTooltip', {
            label: p.label,
            revenue: fmtMoney(p.revenue),
            orders: fmtNum(p.orders),
          }),
        })),
      },
    ];
    if (series.compare) {
      out.push({
        label: t('adminReview.compareSeries'),
        color: '#f59e0b',
        points: series.compare.map((p, i) => ({
          x: aligned.compareX[i] ?? i,
          y: p.revenue,
          tooltip: t('adminReview.chartTooltip', {
            label: p.label,
            revenue: fmtMoney(p.revenue),
            orders: fmtNum(p.orders),
          }),
        })),
      });
    }
    return out;
  }, [series, aligned, fmtMoney, fmtNum, t]);

  const hourlyBars = useMemo(
    () =>
      (data?.hourly || []).map((h) => ({
        label: String(h.hour).padStart(2, '0'),
        value: h.revenue,
        tooltip: t('adminReview.hourlyTooltip', {
          hour: String(h.hour).padStart(2, '0'),
          revenue: fmtMoney(h.revenue),
          orders: fmtNum(h.orders),
        }),
      })),
    [data?.hourly, fmtMoney, fmtNum, t],
  );

  const weekdayBars = useMemo(() => {
    const byDay = new Map(
      (data?.weekday || []).map((w) => [Number(w.dayOfWeek), w]),
    );
    return HEATMAP_DAYS_MON_FIRST.map((dayOfWeek) => {
      const w = byDay.get(dayOfWeek);
      const day = weekdayNames[dayOfWeek] || String(dayOfWeek);
      return {
        label: day,
        value: Number(w?.revenue || 0),
        tooltip: t('adminReview.weekdayTooltip', {
          day,
          revenue: fmtMoney(Number(w?.revenue || 0)),
          orders: fmtNum(Number(w?.orders || 0)),
        }),
      };
    });
  }, [data?.weekday, fmtMoney, fmtNum, t, weekdayNames]);

  const methodLabel = (method: string) => {
    if (method === 'CASH') return t('adminReview.methodCash');
    if (method === 'CARD') return t('adminReview.methodCard');
    return t('adminReview.methodMixed');
  };

  const methodSlices = useMemo(() => {
    const colors: Record<string, string> = {
      CASH: '#34d399',
      CARD: '#60a5fa',
      MIXED: '#f59e0b',
    };
    return (data?.byMethod || [])
      .filter((m) => m.method !== 'MIXED' || m.revenue > 0 || m.orders > 0)
      .map((m) => ({
        id: m.method,
        label: methodLabel(m.method),
        value: m.revenue,
        color: colors[m.method] || '#94a3b8',
      }));
  }, [data?.byMethod, t]);

  const categoryRows = useMemo(
    () =>
      (data?.byCategory || []).slice(0, 8).map((c) => ({
        label: c.name || t('adminReview.uncategorized'),
        value: c.revenue,
        hint: t('adminReview.categoryTooltip', {
          name: c.name || t('adminReview.uncategorized'),
          revenue: fmtMoney(c.revenue),
          qty: fmtNum(c.qty),
        }),
      })),
    [data?.byCategory, fmtMoney, fmtNum, t],
  );

  const areaRows = useMemo(
    () =>
      (data?.byArea || []).map((a) => ({
        label: a.name || t('adminReview.uncategorized'),
        value: a.revenue,
        hint: t('adminReview.areaTooltip', {
          name: a.name || t('adminReview.uncategorized'),
          revenue: fmtMoney(a.revenue),
          orders: fmtNum(a.orders),
        }),
      })),
    [data?.byArea, fmtMoney, fmtNum, t],
  );

  const ticketSizeBars = useMemo(
    () =>
      (data?.ticketSizes || []).map((b) => ({
        label:
          b.max == null
            ? t('adminReview.ticketSizePlus', {
                min: fmtNum(b.min),
              })
            : t('adminReview.ticketSizeFromTo', {
                min: fmtNum(b.min),
                max: fmtNum(b.max),
              }),
        value: b.orders,
        tooltip: t('adminReview.ticketSizeTooltip', {
          orders: fmtNum(b.orders),
          revenue: fmtMoney(b.revenue),
        }),
      })),
    [data?.ticketSizes, fmtMoney, fmtNum, t],
  );

  const chartHasData = chartSeries.some((s) => s.points.some((p) => p.y > 0));
  const hourlyHasData = hourlyBars.some((b) => b.value > 0);
  const weekdayHasData = weekdayBars.some((b) => b.value > 0);
  const heatmapReady = heatmapHasOrders(data?.heatmap);
  const methodHasData = methodSlices.some((s) => s.value > 0);
  const categoryHasData = categoryRows.some((r) => r.value > 0);
  const ticketSizeHasData = ticketSizeBars.some((b) => b.value > 0);
  const areaHasData = areaRows.length > 1;

  return (
    <div className="admin-page">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <p className="max-w-lg text-[13px] leading-relaxed text-gray-500">
          {t('adminReview.subtitle')}
        </p>
        <div
          className="flex flex-wrap items-end gap-3"
          role="toolbar"
          aria-label={t('adminReview.filtersAria')}
        >
          <Field label={t('adminReview.period')}>
            <Select
              className="min-w-[220px] sm:min-w-[280px]"
              value={presetId}
              onChange={(e) => {
                const id = e.target.value as PresetId;
                if (id === 'custom') setPresetId('custom');
                else applyPreset(id);
              }}
            >
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {presetLabel(p.id, t)}
                </option>
              ))}
              <option value="custom">{t('adminReview.customRange')}</option>
            </Select>
          </Field>
          <Field label={t('adminReview.bucket')}>
            <Select
              value={granularity}
              onChange={(e) =>
                setGranularity(e.target.value as ReviewGranularity)
              }
            >
              <option value="day">{t('adminReview.granularityDay')}</option>
              <option value="month">{t('adminReview.granularityMonth')}</option>
              <option value="year">{t('adminReview.granularityYear')}</option>
            </Select>
          </Field>
          <div className="flex h-[var(--pos-control-h)] items-center gap-2 pb-px">
            <Switch
              checked={compareEnabled}
              onChange={setCompareEnabled}
              label={t('adminReview.compare')}
            />
            <span className="text-[13px] text-gray-200">
              {t('adminReview.compare')}
            </span>
          </div>
        </div>
      </div>

      {presetId === 'custom' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <fieldset className="min-w-0">
            <legend className="admin-kicker mb-2 px-0">
              {t('adminReview.currentPeriod')}
            </legend>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="date"
                value={curStart}
                max={curEnd}
                onChange={(e) => {
                  setPresetId('custom');
                  setCurStart(e.target.value);
                }}
                className="w-auto"
              />
              <span className="text-[12px] text-gray-500">
                {t('adminReview.dateTo')}
              </span>
              <Input
                type="date"
                value={curEnd}
                min={curStart}
                onChange={(e) => {
                  setPresetId('custom');
                  setCurEnd(e.target.value);
                }}
                className="w-auto"
              />
            </div>
          </fieldset>
          <fieldset className={cn('min-w-0', !compareEnabled && 'opacity-50')}>
            <legend className="admin-kicker mb-2 px-0">
              {t('adminReview.comparePeriod')}
            </legend>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="date"
                value={cmpStart}
                max={cmpEnd}
                disabled={!compareEnabled}
                onChange={(e) => {
                  setPresetId('custom');
                  setCmpStart(e.target.value);
                }}
                className="w-auto"
              />
              <span className="text-[12px] text-gray-500">
                {t('adminReview.dateTo')}
              </span>
              <Input
                type="date"
                value={cmpEnd}
                min={cmpStart}
                disabled={!compareEnabled}
                onChange={(e) => {
                  setPresetId('custom');
                  setCmpEnd(e.target.value);
                }}
                className="w-auto"
              />
            </div>
          </fieldset>
        </div>
      ) : null}

      {error && (
        <div className="rounded-lg border border-rose-800 bg-rose-900/30 p-3 text-sm text-rose-100">
          {error}
        </div>
      )}

      <MetricGroup title={t('adminReview.groupSales')}>
        <KpiCard
          label={t('adminReview.revenueGross')}
          value={fmtMoney(currentGross)}
          showComparison={compareEnabled}
          prev={compare ? fmtMoney(compareGross) : null}
          delta={deltaFor(currentGross, compare ? compareGross : null)}
        />
        <KpiCard
          label={t('adminReview.revenueNet')}
          value={fmtMoney(summary?.revenueNet ?? 0)}
          showComparison={compareEnabled}
          prev={compare ? fmtMoney(compare.revenueNet) : null}
          delta={deltaFor(summary?.revenueNet ?? 0, compare?.revenueNet)}
        />
        <KpiCard
          label={t('adminReview.vat')}
          value={fmtMoney(summary?.revenueVat ?? 0)}
          showComparison={compareEnabled}
          prev={compare ? fmtMoney(compare.revenueVat) : null}
          delta={deltaFor(summary?.revenueVat ?? 0, compare?.revenueVat)}
        />
      </MetricGroup>

      <MetricGroup title={t('adminReview.groupActivity')}>
        <KpiCard
          label={t('adminReview.orders')}
          value={fmtNum(summary?.orders ?? 0)}
          showComparison={compareEnabled}
          prev={compare ? fmtNum(compare.orders) : null}
          delta={deltaFor(summary?.orders ?? 0, compare?.orders)}
          hint={t('adminReview.ordersHint')}
        />
        <KpiCard
          label={t('adminReview.itemsSold')}
          value={fmtNum(summary?.items ?? 0)}
          showComparison={compareEnabled}
          prev={compare ? fmtNum(compare.items) : null}
          delta={deltaFor(summary?.items ?? 0, compare?.items)}
        />
        <KpiCard
          label={t('adminReview.avgTicket')}
          value={fmtMoney(summary?.avgTicket ?? 0)}
          showComparison={compareEnabled}
          prev={compare ? fmtMoney(compare.avgTicket) : null}
          delta={deltaFor(summary?.avgTicket ?? 0, compare?.avgTicket)}
        />
        {hasTables ? (
          <KpiCard
            label={t('adminReview.avgSpendPerCover')}
            value={
              (summary?.covers ?? 0) > 0
                ? fmtMoney(summary?.avgSpendPerCover ?? 0)
                : '—'
            }
            showComparison={compareEnabled && (compare?.covers ?? 0) > 0}
            prev={
              (compare?.covers ?? 0) > 0
                ? fmtMoney(compare?.avgSpendPerCover ?? 0)
                : null
            }
            delta={deltaFor(
              summary?.avgSpendPerCover ?? 0,
              (compare?.covers ?? 0) > 0 ? compare?.avgSpendPerCover : null,
            )}
            hint={t('adminReview.avgSpendPerCoverHint')}
          />
        ) : null}
      </MetricGroup>

      <MetricGroup
        title={t(
          hasTables
            ? 'adminReview.groupGuestsControl'
            : 'adminReview.groupControl',
        )}
      >
        {hasTables ? (
          <KpiCard
            label={t('adminReview.covers')}
            value={fmtNum(summary?.covers ?? 0)}
            showComparison={compareEnabled}
            prev={compare ? fmtNum(compare.covers) : null}
            delta={deltaFor(summary?.covers ?? 0, compare?.covers)}
            hint={t('adminReview.coversHint')}
          />
        ) : null}
        <KpiCard
          label={t('adminReview.avgItemsPerTicket')}
          value={fmtNum(summary?.avgItemsPerTicket ?? 0)}
          showComparison={compareEnabled}
          prev={compare ? fmtNum(compare.avgItemsPerTicket) : null}
          delta={deltaFor(
            summary?.avgItemsPerTicket ?? 0,
            compare?.avgItemsPerTicket,
          )}
        />
        <KpiCard
          label={t('adminReview.voidedTickets')}
          value={fmtNum(summary?.voidedTickets ?? 0)}
          showComparison={compareEnabled}
          prev={compare ? fmtNum(compare.voidedTickets) : null}
          delta={deltaFor(summary?.voidedTickets ?? 0, compare?.voidedTickets)}
        />
      </MetricGroup>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <Panel
          title={t('adminReview.revenueOverTime')}
          actions={
            chartHasData ? (
              <Legend
                items={[
                  { label: t('adminReview.current'), color: '#60a5fa' },
                  ...(series?.compare
                    ? [
                        {
                          label: t('adminReview.compareSeries'),
                          color: '#f59e0b',
                        },
                      ]
                    : []),
                ]}
              />
            ) : null
          }
        >
          {loading && !data ? (
            <div className="relative h-[240px] overflow-hidden">
              <PageSpinner
                variant="overlay"
                message={t('adminReview.loading')}
              />
            </div>
          ) : chartHasData ? (
            <LineChart
              series={chartSeries}
              xLabels={chartLabels}
              height={260}
              yLabel={t('adminReview.revenueAxisGross', { currency })}
            />
          ) : (
            <EmptyState
              compact
              title={t('adminReview.emptyChart')}
              description={t('adminReview.emptyChartHint')}
            />
          )}
        </Panel>

        <Panel
          title={t('adminReview.ordersByTime')}
          actions={<OrdersByTimeLegend cells={data?.heatmap} />}
        >
          {loading && !data ? (
            <div className="relative h-[240px] overflow-hidden">
              <PageSpinner
                variant="overlay"
                message={t('adminReview.loading')}
              />
            </div>
          ) : heatmapReady ? (
            <OrdersByTimeChart
              cells={data?.heatmap}
              weekdayNames={weekdayNames}
              fmtMoney={fmtMoney}
            />
          ) : (
            <EmptyState
              compact
              title={t('adminReview.emptyChart')}
              description={t('adminReview.emptyChartHint')}
            />
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title={t('adminReview.salesByHour')}>
          {hourlyHasData ? (
            <BarChart data={hourlyBars} height={180} format={fmtMoney} />
          ) : (
            <EmptyState compact title={t('adminReview.emptyChart')} />
          )}
        </Panel>

        <Panel title={t('adminReview.salesByWeekday')}>
          {weekdayHasData ? (
            <BarChart
              data={weekdayBars}
              height={180}
              format={fmtMoney}
              color="#a78bfa"
            />
          ) : (
            <EmptyState compact title={t('adminReview.emptyChart')} />
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <Panel title={t('adminReview.topItemsTitleGross')}>
          {data?.topItems?.length ? (
            <TableFrame>
              <Table>
                <thead>
                  <tr>
                    <Th>{t('adminReview.item')}</Th>
                    <Th numeric>{t('adminReview.qty')}</Th>
                    <Th numeric>{t('adminReview.revenue')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.topItems.map((it) => (
                    <tr key={it.name}>
                      <Td>
                        <span className="block max-w-[240px] truncate">
                          {it.name}
                        </span>
                      </Td>
                      <Td numeric>{fmtNum(it.qty)}</Td>
                      <Td numeric>{fmtMoney(it.revenue)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableFrame>
          ) : (
            <EmptyState compact title={t('adminReview.noItemsSold')} />
          )}
        </Panel>

        <Panel
          title={t('adminReview.salesByCategory')}
          actions={
            <span className="text-[12px] text-gray-500">
              {t('adminReview.categoryHint')}
            </span>
          }
        >
          {categoryHasData ? (
            <RankChart rows={categoryRows} format={fmtMoney} />
          ) : (
            <EmptyState compact title={t('adminReview.emptyChart')} />
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title={t('adminReview.paymentMix')}>
          {methodHasData ? (
            <ShareBar slices={methodSlices} format={fmtMoney} />
          ) : (
            <EmptyState compact title={t('adminReview.emptyChart')} />
          )}
        </Panel>
        <Panel title={t('adminReview.ticketSize')}>
          {ticketSizeHasData ? (
            <BarChart
              data={ticketSizeBars}
              height={160}
              format={fmtNum}
              color="#fbbf24"
            />
          ) : (
            <EmptyState compact title={t('adminReview.emptyChart')} />
          )}
        </Panel>
        {areaHasData ? (
          <Panel title={t('adminReview.salesByArea')}>
            <RankChart rows={areaRows} format={fmtMoney} color="#a78bfa" />
          </Panel>
        ) : null}
      </div>

      <Panel
        title={t('adminReview.waiterPerformance')}
        actions={
          <span className="text-[12px] text-gray-500">
            {t('adminReview.staffWithSales', {
              count: data?.waiters?.length ?? 0,
            })}
          </span>
        }
      >
        <WaiterTable
          waiters={data?.waiters || []}
          fmtMoney={fmtMoney}
          fmtNum={fmtNum}
          totalRevenue={currentGross}
        />
      </Panel>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <PeriodSummaryCard
          title={t('adminReview.currentPeriod')}
          summary={summary}
          fmtMoney={fmtMoney}
          fmtNum={fmtNum}
        />
        {compareEnabled && (
          <PeriodSummaryCard
            title={t('adminReview.comparePeriod')}
            summary={compare}
            fmtMoney={fmtMoney}
            fmtNum={fmtNum}
          />
        )}
      </div>
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex items-center gap-3 text-[12px] text-gray-400">
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-1.5">
          <span
            className="inline-block size-2 rounded-sm"
            style={{ background: it.color }}
          />
          <span>{it.label}</span>
        </div>
      ))}
    </div>
  );
}

function PeriodSummaryCard({
  title,
  summary,
  fmtMoney,
  fmtNum,
}: {
  title: string;
  summary: ReviewSummaryDTO | null | undefined;
  fmtMoney: (n: number) => string;
  fmtNum: (n: number) => string;
}) {
  const { t } = useTranslation();
  const hasTables = useLicenseCapabilities((s) => s.hasTables);
  if (!summary) {
    return (
      <Panel title={title}>
        <p className="text-[13px] text-gray-500">
          {t('adminReview.periodNotSelected', { title })}
        </p>
      </Panel>
    );
  }
  const start = new Date(summary.startIso);
  const end = new Date(summary.endIso);
  const fmtDate = (d: Date) =>
    `${String(d.getMonth() + 1).padStart(2, '0')}/${String(
      d.getDate(),
    ).padStart(2, '0')}/${d.getFullYear()}`;
  const rows: { k: string; v: string }[] = [
    {
      k: t('adminReview.summaryRange'),
      v: `${fmtDate(start)} – ${fmtDate(end)}`,
    },
    {
      k: t('adminReview.summaryRevenueGross'),
      v: fmtMoney(grossRevenueOf(summary)),
    },
    { k: t('adminReview.summaryRevenueNet'), v: fmtMoney(summary.revenueNet) },
    { k: t('adminReview.summaryVat'), v: fmtMoney(summary.revenueVat) },
    { k: t('adminReview.summaryOrders'), v: fmtNum(summary.orders) },
    { k: t('adminReview.summaryItemsSold'), v: fmtNum(summary.items) },
    ...(hasTables
      ? [{ k: t('adminReview.summaryCovers'), v: fmtNum(summary.covers) }]
      : []),
    { k: t('adminReview.summaryAvgTicket'), v: fmtMoney(summary.avgTicket) },
    ...(hasTables
      ? [
          {
            k: t('adminReview.summaryAvgSpendPerCover'),
            v:
              summary.covers > 0
                ? fmtMoney(summary.avgSpendPerCover ?? 0)
                : '—',
          },
        ]
      : []),
    {
      k: t('adminReview.summaryAvgItemsPerTicket'),
      v: fmtNum(summary.avgItemsPerTicket),
    },
    ...(hasTables
      ? [
          {
            k: t('adminReview.summaryUniqueTables'),
            v: fmtNum(summary.uniqueTables),
          },
        ]
      : []),
    {
      k: t(
        hasTables
          ? 'adminReview.summaryWaitersWithSales'
          : 'adminReview.summaryCashiersWithSales',
      ),
      v: fmtNum(summary.uniqueWaiters),
    },
    {
      k: t('adminReview.summaryVoidedTickets'),
      v: fmtNum(summary.voidedTickets),
    },
  ];
  return (
    <Panel title={title}>
      <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        {rows.map((r) => (
          <div
            key={r.k}
            className="flex items-baseline justify-between gap-3 border-b border-white/6 py-2 text-[13px]"
          >
            <dt className="text-gray-400">{r.k}</dt>
            <dd className="tabular-nums text-gray-100">{r.v}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

type SortKey =
  | 'revenue'
  | 'orders'
  | 'items'
  | 'avgTicket'
  | 'covers'
  | 'hoursWorked'
  | 'revenuePerHour';

function WaiterTable({
  waiters,
  fmtMoney,
  fmtNum,
  totalRevenue,
}: {
  waiters: ReviewDTO['waiters'];
  fmtMoney: (n: number) => string;
  fmtNum: (n: number) => string;
  totalRevenue: number;
}) {
  const { t } = useTranslation();
  const hasTables = useLicenseCapabilities((s) => s.hasTables);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: 'revenue',
    desc: true,
  });

  const sorted = useMemo(() => {
    const out = [...waiters];
    out.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      const dir = sort.desc ? -1 : 1;
      return av === bv ? 0 : av < bv ? -1 * dir : 1 * dir;
    });
    return out;
  }, [waiters, sort]);

  const max = Math.max(1, ...waiters.map((w) => w.revenue));

  if (waiters.length === 0) {
    return <EmptyState compact title={t('adminReview.noWaiterActivity')} />;
  }

  const headerBtn = (key: SortKey, label: string) => (
    <button
      type="button"
      onClick={() =>
        setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))
      }
      className="inline-flex items-center gap-0.5 hover:text-white"
    >
      {label}
      <span className="opacity-50 text-[10px]">
        {sort.key === key ? (sort.desc ? '↓' : '↑') : ''}
      </span>
    </button>
  );

  return (
    <TableFrame>
      <Table className="min-w-[720px]">
        <thead>
          <tr>
            <Th>{t('adminReview.staff')}</Th>
            <Th>{t('adminReview.role')}</Th>
            <Th numeric>{headerBtn('revenue', t('adminReview.revenue'))}</Th>
            <Th numeric>{headerBtn('orders', t('adminReview.orders'))}</Th>
            <Th numeric>{headerBtn('items', t('adminReview.items'))}</Th>
            {hasTables ? (
              <Th numeric>{headerBtn('covers', t('adminReview.covers'))}</Th>
            ) : null}
            <Th numeric>
              {headerBtn('avgTicket', t('adminReview.avgTicket'))}
            </Th>
            <Th numeric>{headerBtn('hoursWorked', t('adminReview.hours'))}</Th>
            <Th numeric>
              {headerBtn('revenuePerHour', t('adminReview.perHour'))}
            </Th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((w) => {
            const share = totalRevenue > 0 ? w.revenue / totalRevenue : 0;
            return (
              <tr key={w.userId}>
                <Td>
                  <div className="flex items-center gap-2">
                    <div className="pos-avatar">{w.name.slice(0, 1)}</div>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{w.name}</div>
                      {!w.active && (
                        <Badge tone="danger">{t('adminReview.inactive')}</Badge>
                      )}
                    </div>
                  </div>
                </Td>
                <Td muted>{w.role}</Td>
                <Td numeric>
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-1.5 w-16 overflow-hidden rounded bg-gray-700">
                      <div
                        className="h-full bg-blue-500"
                        style={{
                          width: `${Math.min(100, (w.revenue / max) * 100)}%`,
                        }}
                      />
                    </div>
                    <span>{fmtMoney(w.revenue)}</span>
                    <span className="w-10 text-right text-[11px] text-gray-500 tabular-nums">
                      {fmtNum(share * 100)}%
                    </span>
                  </div>
                </Td>
                <Td numeric>{fmtNum(w.orders)}</Td>
                <Td numeric>{fmtNum(w.items)}</Td>
                {hasTables ? <Td numeric>{fmtNum(w.covers)}</Td> : null}
                <Td numeric>{fmtMoney(w.avgTicket)}</Td>
                <Td numeric>
                  {w.hoursWorked > 0 ? fmtNum(w.hoursWorked) : '—'}
                </Td>
                <Td numeric>
                  {w.hoursWorked > 0 ? fmtMoney(w.revenuePerHour) : '—'}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </TableFrame>
  );
}
