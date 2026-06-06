import { useEffect, useMemo, useRef, useState } from 'react';
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
      const prev = addMonths(new Date(), -1);
      return { start: startOfMonth(prev), end: endOfMonth(prev) };
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
      const ly = addYears(new Date(), -1);
      return { start: startOfYear(ly), end: endOfYear(ly) };
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

function LineChart({
  series,
  height = 240,
  yLabel,
  xLabels,
}: {
  series: LineSeries[];
  height?: number;
  yLabel?: string;
  xLabels: string[];
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

  const maxPoints = Math.max(1, ...series.map((s) => s.points.length));
  const xStep = maxPoints > 1 ? innerW / (maxPoints - 1) : innerW;

  const yTicks = 4;
  const ticks = Array.from(
    { length: yTicks + 1 },
    (_, i) => (yMax * i) / yTicks,
  );

  const showEvery = Math.max(1, Math.ceil(maxPoints / 8));

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
              const x = padding.left + i * xStep;
              const y = padding.top + innerH - (p.y / yMax) * innerH;
              return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
            })
            .join(' ');
          const areaPath =
            sIdx === 0
              ? `${path} L ${(padding.left + (s.points.length - 1) * xStep).toFixed(2)} ${(
                  padding.top + innerH
                ).toFixed(2)} L ${padding.left.toFixed(2)} ${(
                  padding.top + innerH
                ).toFixed(2)} Z`
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
                const x = padding.left + i * xStep;
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
        {xLabels.map((lbl, i) => {
          if (i % showEvery !== 0 && i !== xLabels.length - 1) return null;
          const x = padding.left + i * xStep;
          return (
            <text
              key={i}
              x={x}
              y={padding.top + innerH + 16}
              textAnchor="middle"
              fontSize="10"
              fill="currentColor"
              opacity={0.7}
            >
              {lbl}
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
  const dirCls =
    dir > 0 ? 'text-emerald-400' : dir < 0 ? 'text-rose-400' : 'text-gray-400';
  const arrow = dir > 0 ? '▲' : dir < 0 ? '▼' : '–';
  return (
    <div className="bg-gray-800/70 border border-gray-700 rounded-lg p-3 sm:p-4 flex flex-col gap-1 min-w-0">
      <div className="text-[11px] uppercase tracking-wide opacity-70">
        {label}
      </div>
      <div className="text-xl sm:text-2xl font-semibold tabular-nums truncate">
        {value}
      </div>
      {showComparison ? (
        <div className="text-xs flex items-center gap-2 mt-0.5">
          {delta != null ? (
            <span className={`${dirCls} tabular-nums`}>
              {arrow} {fmtPct(delta)}
            </span>
          ) : (
            <span className="opacity-50">{t('adminReview.noComparison')}</span>
          )}
          {prev != null && (
            <span className="opacity-60 truncate">
              {t('adminReview.vs')} {prev}
            </span>
          )}
        </div>
      ) : null}
      {hint && <div className="text-[11px] opacity-50 mt-1">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------

export default function AdminReviewPage() {
  const { t } = useTranslation();
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

  // Build aligned x labels: the longer of the two series.
  const chartLabels = useMemo<string[]>(() => {
    if (!series) return [];
    const cur = series.current || [];
    const cmp = series.compare || [];
    return cur.length >= cmp.length
      ? cur.map((p) => p.label)
      : cmp.map((p) => p.label);
  }, [series]);

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
        points: cur.map((p) => ({
          x: 0,
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
        points: series.compare.map((p) => ({
          x: 0,
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
  }, [series, fmtMoney, fmtNum, t]);

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
    return (data?.weekday || []).map((w) => ({
      label: weekdayNames[w.dayOfWeek] || String(w.dayOfWeek),
      value: w.revenue,
      tooltip: t('adminReview.weekdayTooltip', {
        day: weekdayNames[w.dayOfWeek] || String(w.dayOfWeek),
        revenue: fmtMoney(w.revenue),
        orders: fmtNum(w.orders),
      }),
    }));
  }, [data?.weekday, fmtMoney, fmtNum, t, weekdayNames]);

  return (
    <div className="space-y-4">
      {/* Header / controls */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-semibold">
              {t('adminReview.title')}
            </h1>
            <p className="text-xs opacity-70 mt-0.5">
              {t('adminReview.subtitle')}
            </p>
          </div>

          <div
            className="flex flex-wrap items-center gap-1 rounded-lg border border-gray-700 bg-gray-900/50 p-1.5 w-full lg:w-auto shrink-0"
            role="toolbar"
            aria-label={t('adminReview.filtersAria')}
          >
            <label className="flex items-center gap-2 pl-2 pr-1 py-1 min-w-0 flex-1 sm:flex-none">
              <span className="text-xs font-medium text-gray-400 shrink-0">
                {t('adminReview.period')}
              </span>
              <select
                value={presetId}
                onChange={(e) => {
                  const id = e.target.value as PresetId;
                  if (id === 'custom') setPresetId('custom');
                  else applyPreset(id);
                }}
                className="h-9 min-w-0 flex-1 sm:min-w-[200px] sm:max-w-[260px] bg-gray-950 border border-gray-600 rounded-md px-2.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
              >
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {presetLabel(p.id, t)}
                  </option>
                ))}
                <option value="custom">{t('adminReview.customRange')}</option>
              </select>
            </label>

            <div
              className="hidden sm:block w-px h-7 bg-gray-700 shrink-0"
              aria-hidden
            />

            <label className="flex items-center gap-2 px-2 py-1 shrink-0">
              <span className="text-xs font-medium text-gray-400">
                {t('adminReview.bucket')}
              </span>
              <select
                value={granularity}
                onChange={(e) =>
                  setGranularity(e.target.value as ReviewGranularity)
                }
                className="h-9 bg-gray-950 border border-gray-600 rounded-md px-2.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
              >
                <option value="day">{t('adminReview.granularityDay')}</option>
                <option value="month">
                  {t('adminReview.granularityMonth')}
                </option>
                <option value="year">{t('adminReview.granularityYear')}</option>
              </select>
            </label>

            <div
              className="hidden sm:block w-px h-7 bg-gray-700 shrink-0"
              aria-hidden
            />

            <label className="flex items-center gap-2 h-9 px-3 cursor-pointer shrink-0 select-none">
              <input
                type="checkbox"
                checked={compareEnabled}
                onChange={(e) => setCompareEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-gray-600 bg-gray-950 accent-blue-500"
              />
              <span className="text-sm text-gray-200">
                {t('adminReview.compare')}
              </span>
            </label>
          </div>
        </div>

        {presetId === 'custom' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <fieldset className="bg-gray-900/60 border border-gray-700 rounded p-2 sm:p-3">
              <legend className="text-xs px-1 opacity-70">
                {t('adminReview.currentPeriod')}
              </legend>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="date"
                  value={curStart}
                  max={curEnd}
                  onChange={(e) => {
                    setPresetId('custom');
                    setCurStart(e.target.value);
                  }}
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm"
                />
                <span className="opacity-60 text-xs">
                  {t('adminReview.dateTo')}
                </span>
                <input
                  type="date"
                  value={curEnd}
                  min={curStart}
                  onChange={(e) => {
                    setPresetId('custom');
                    setCurEnd(e.target.value);
                  }}
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm"
                />
              </div>
            </fieldset>
            <fieldset
              className={`bg-gray-900/60 border rounded p-2 sm:p-3 ${
                compareEnabled
                  ? 'border-gray-700'
                  : 'border-gray-800 opacity-50'
              }`}
            >
              <legend className="text-xs px-1 opacity-70">
                {t('adminReview.comparePeriod')}
              </legend>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="date"
                  value={cmpStart}
                  max={cmpEnd}
                  disabled={!compareEnabled}
                  onChange={(e) => {
                    setPresetId('custom');
                    setCmpStart(e.target.value);
                  }}
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm disabled:cursor-not-allowed"
                />
                <span className="opacity-60 text-xs">
                  {t('adminReview.dateTo')}
                </span>
                <input
                  type="date"
                  value={cmpEnd}
                  min={cmpStart}
                  disabled={!compareEnabled}
                  onChange={(e) => {
                    setPresetId('custom');
                    setCmpEnd(e.target.value);
                  }}
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm disabled:cursor-not-allowed"
                />
              </div>
            </fieldset>
          </div>
        ) : null}
      </div>

      {error && (
        <div className="bg-rose-900/30 border border-rose-800 text-rose-100 rounded p-3 text-sm">
          {error}
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
        <KpiCard
          label={t('adminReview.revenueNet')}
          value={fmtMoney(summary?.revenueNet ?? 0)}
          showComparison={compareEnabled}
          prev={compare ? fmtMoney(compare.revenueNet) : null}
          delta={deltaFor(summary?.revenueNet ?? 0, compare?.revenueNet)}
        />
        <KpiCard
          label={t('adminReview.orders')}
          value={fmtNum(summary?.orders ?? 0)}
          showComparison={compareEnabled}
          prev={compare ? fmtNum(compare.orders) : null}
          delta={deltaFor(summary?.orders ?? 0, compare?.orders)}
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
        <KpiCard
          label={t('adminReview.covers')}
          value={fmtNum(summary?.covers ?? 0)}
          showComparison={compareEnabled}
          prev={compare ? fmtNum(compare.covers) : null}
          delta={deltaFor(summary?.covers ?? 0, compare?.covers)}
          hint={t('adminReview.coversHint')}
        />
        <KpiCard
          label={t('adminReview.voidedTickets')}
          value={fmtNum(summary?.voidedTickets ?? 0)}
          showComparison={compareEnabled}
          prev={compare ? fmtNum(compare.voidedTickets) : null}
          delta={deltaFor(summary?.voidedTickets ?? 0, compare?.voidedTickets)}
        />
      </div>

      {/* Revenue chart */}
      <div className="bg-gray-800 rounded-lg p-3 sm:p-4 border border-gray-700">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold">
            {t('adminReview.revenueOverTime')}
          </h2>
          <Legend
            items={[
              { label: t('adminReview.current'), color: '#60a5fa' },
              ...(series?.compare
                ? [{ label: t('adminReview.compareSeries'), color: '#f59e0b' }]
                : []),
            ]}
          />
        </div>
        {loading && !data ? (
          <div className="h-[240px] flex items-center justify-center opacity-60 text-sm">
            {t('adminReview.loading')}
          </div>
        ) : (
          <LineChart
            series={chartSeries}
            xLabels={chartLabels}
            height={260}
            yLabel={t('adminReview.revenueAxis', { currency })}
          />
        )}
      </div>

      {/* Two-column: top items + hourly */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="bg-gray-800 rounded-lg p-3 sm:p-4 border border-gray-700">
          <h2 className="text-sm font-semibold mb-2">
            {t('adminReview.topItemsTitle')}
          </h2>
          {data?.topItems?.length ? (
            <table className="w-full text-sm">
              <thead className="text-xs opacity-70">
                <tr className="border-b border-gray-700/60">
                  <th className="text-left py-1.5">{t('adminReview.item')}</th>
                  <th className="text-right py-1.5">{t('adminReview.qty')}</th>
                  <th className="text-right py-1.5">
                    {t('adminReview.revenue')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.topItems.map((it) => (
                  <tr key={it.name} className="border-b border-gray-700/30">
                    <td className="py-1.5 truncate max-w-[280px]">{it.name}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {fmtNum(it.qty)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {fmtMoney(it.revenue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-sm opacity-60 py-4">
              {t('adminReview.noItemsSold')}
            </div>
          )}
        </div>

        <div className="bg-gray-800 rounded-lg p-3 sm:p-4 border border-gray-700">
          <h2 className="text-sm font-semibold mb-2">
            {t('adminReview.salesByHour')}
          </h2>
          <BarChart data={hourlyBars} height={180} format={fmtMoney} />
          <h2 className="text-sm font-semibold mt-4 mb-2">
            {t('adminReview.salesByWeekday')}
          </h2>
          <BarChart
            data={weekdayBars}
            height={140}
            format={fmtMoney}
            color="#a78bfa"
          />
        </div>
      </div>

      {/* Waiter performance */}
      <div className="bg-gray-800 rounded-lg p-3 sm:p-4 border border-gray-700">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h2 className="text-sm font-semibold">
            {t('adminReview.waiterPerformance')}
          </h2>
          <span className="text-xs opacity-60">
            {t('adminReview.staffWithSales', {
              count: data?.waiters?.length ?? 0,
            })}
          </span>
        </div>
        <WaiterTable
          waiters={data?.waiters || []}
          fmtMoney={fmtMoney}
          fmtNum={fmtNum}
          totalRevenue={summary?.revenueNet ?? 0}
        />
      </div>

      {/* Period summary card at bottom for quick review */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
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
    <div className="flex items-center gap-3 text-xs">
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-1.5">
          <span
            className="inline-block w-2.5 h-2.5 rounded-sm"
            style={{ background: it.color }}
          />
          <span className="opacity-80">{it.label}</span>
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
  if (!summary) {
    return (
      <div className="bg-gray-800 rounded-lg p-3 sm:p-4 border border-gray-700 text-sm opacity-60">
        {t('adminReview.periodNotSelected', { title })}
      </div>
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
    { k: t('adminReview.summaryRevenueNet'), v: fmtMoney(summary.revenueNet) },
    { k: t('adminReview.summaryVat'), v: fmtMoney(summary.revenueVat) },
    {
      k: t('adminReview.summaryRevenueGross'),
      v: fmtMoney(summary.revenueNet + summary.revenueVat),
    },
    { k: t('adminReview.summaryOrders'), v: fmtNum(summary.orders) },
    { k: t('adminReview.summaryItemsSold'), v: fmtNum(summary.items) },
    { k: t('adminReview.summaryCovers'), v: fmtNum(summary.covers) },
    { k: t('adminReview.summaryAvgTicket'), v: fmtMoney(summary.avgTicket) },
    {
      k: t('adminReview.summaryAvgItemsPerTicket'),
      v: fmtNum(summary.avgItemsPerTicket),
    },
    {
      k: t('adminReview.summaryUniqueTables'),
      v: fmtNum(summary.uniqueTables),
    },
    {
      k: t('adminReview.summaryWaitersWithSales'),
      v: fmtNum(summary.uniqueWaiters),
    },
    {
      k: t('adminReview.summaryVoidedTickets'),
      v: fmtNum(summary.voidedTickets),
    },
  ];
  return (
    <div className="bg-gray-800 rounded-lg p-3 sm:p-4 border border-gray-700">
      <h2 className="text-sm font-semibold mb-2">{title}</h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        {rows.map((r) => (
          <div
            key={r.k}
            className="flex items-center justify-between border-b border-gray-700/40 py-1"
          >
            <dt className="opacity-70">{r.k}</dt>
            <dd className="tabular-nums">{r.v}</dd>
          </div>
        ))}
      </dl>
    </div>
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
    return (
      <div className="text-sm opacity-60 py-4">
        {t('adminReview.noWaiterActivity')}
      </div>
    );
  }

  const headerBtn = (key: SortKey, label: string) => (
    <button
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
    <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[720px]">
        <thead className="text-xs opacity-70">
          <tr className="border-b border-gray-700/60">
            <th className="text-left py-1.5">{t('adminReview.staff')}</th>
            <th className="text-left py-1.5">{t('adminReview.role')}</th>
            <th className="text-right py-1.5">
              {headerBtn('revenue', t('adminReview.revenue'))}
            </th>
            <th className="text-right py-1.5">
              {headerBtn('orders', t('adminReview.orders'))}
            </th>
            <th className="text-right py-1.5">
              {headerBtn('items', t('adminReview.items'))}
            </th>
            <th className="text-right py-1.5">
              {headerBtn('covers', t('adminReview.covers'))}
            </th>
            <th className="text-right py-1.5">
              {headerBtn('avgTicket', t('adminReview.avgTicket'))}
            </th>
            <th className="text-right py-1.5">
              {headerBtn('hoursWorked', t('adminReview.hours'))}
            </th>
            <th className="text-right py-1.5">
              {headerBtn('revenuePerHour', t('adminReview.perHour'))}
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((w) => {
            const share = totalRevenue > 0 ? w.revenue / totalRevenue : 0;
            return (
              <tr key={w.userId} className="border-b border-gray-700/30">
                <td className="py-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full bg-gray-700 flex items-center justify-center text-xs font-semibold">
                      {w.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="truncate max-w-[180px]">
                      <div className="truncate">{w.name}</div>
                      {!w.active && (
                        <div className="text-[10px] uppercase tracking-wide text-rose-400">
                          {t('adminReview.inactive')}
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="py-1.5 text-xs opacity-70">{w.role}</td>
                <td className="py-1.5 text-right tabular-nums">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-20 h-1.5 bg-gray-700 rounded overflow-hidden">
                      <div
                        className="h-full bg-emerald-500"
                        style={{
                          width: `${Math.min(100, (w.revenue / max) * 100)}%`,
                        }}
                      />
                    </div>
                    <span>{fmtMoney(w.revenue)}</span>
                    <span className="opacity-70 text-xs tabular-nums w-10 text-right">
                      {fmtNum(share * 100)}%
                    </span>
                  </div>
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {fmtNum(w.orders)}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {fmtNum(w.items)}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {fmtNum(w.covers)}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {fmtMoney(w.avgTicket)}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {w.hoursWorked > 0 ? fmtNum(w.hoursWorked) : '—'}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {w.hoursWorked > 0 ? fmtMoney(w.revenuePerHour) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
