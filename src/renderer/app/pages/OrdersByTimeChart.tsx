import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewHeatmapCellDTO } from '@shared/ipc';
import {
  HEATMAP_DAYS_MON_FIRST,
  heatmapHourRange,
  heatmapLevel,
  heatmapMaxOrders,
  heatmapThresholds,
  reviewHeatmapIndex,
  type HeatmapLevel,
  type ReviewHeatmapCell,
} from '@shared/reviewHeatmap';
import { formatNumberMaxDecimals } from '../../utils/format';
import { cn } from '../../components/ui/cn';

function fillGrid(
  cells: ReviewHeatmapCellDTO[] | undefined,
): ReviewHeatmapCell[] {
  const filled: ReviewHeatmapCell[] = Array.from({ length: 168 }, (_, i) => ({
    dayOfWeek: Math.floor(i / 24),
    hour: i % 24,
    orders: 0,
    revenue: 0,
  }));
  for (const cell of cells || []) {
    const i = reviewHeatmapIndex(cell.dayOfWeek, cell.hour);
    if (i < 0 || i >= filled.length) continue;
    filled[i] = {
      dayOfWeek: cell.dayOfWeek,
      hour: cell.hour,
      orders: cell.orders,
      revenue: cell.revenue,
    };
  }
  return filled;
}

function hourLabel(
  hour: number,
  t: (key: string, opts: { hour: number; hour24: string }) => string,
) {
  const h12 = hour % 12 || 12;
  const hour24 = String(hour).padStart(2, '0');
  return hour < 12
    ? t('adminReview.hourAm', { hour: h12, hour24 })
    : t('adminReview.hourPm', { hour: h12, hour24 });
}

function HeatSwatch({ level }: { level: Exclude<HeatmapLevel, 0> }) {
  return (
    <span
      className={cn('review-heat-swatch', `review-heat-cell--${level}`)}
      aria-hidden
    />
  );
}

export function OrdersByTimeLegend({
  cells,
}: {
  cells: ReviewHeatmapCellDTO[] | undefined;
}) {
  const { t } = useTranslation();
  const max = heatmapMaxOrders(fillGrid(cells));
  if (max <= 0) return null;
  const thresholds = heatmapThresholds(max);
  return (
    <div className="review-heat-legend">
      {([1, 2, 3, 4] as const).map((level) => (
        <div key={level} className="review-heat-legend-item">
          <HeatSwatch level={level} />
          <span>
            {t('adminReview.heatmapLegend', {
              count: formatNumberMaxDecimals(thresholds[level - 1], 0),
            })}
          </span>
        </div>
      ))}
    </div>
  );
}

export function OrdersByTimeChart({
  cells,
  weekdayNames,
  fmtMoney,
}: {
  cells: ReviewHeatmapCellDTO[] | undefined;
  weekdayNames: string[];
  fmtMoney: (n: number) => string;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<string | null>(null);
  const grid = useMemo(() => fillGrid(cells), [cells]);
  const hours = heatmapHourRange(grid);
  const max = heatmapMaxOrders(grid);
  const thresholds = heatmapThresholds(max);
  const hourList = hours
    ? Array.from(
        { length: hours.end - hours.start + 1 },
        (_, i) => hours.start + i,
      )
    : [];

  if (!hours) return null;

  return (
    <div>
      <div
        className="review-heat-grid"
        role="img"
        aria-label={t('adminReview.ordersByTime')}
      >
        {hourList.map((hour) => (
          <div key={hour} className="contents">
            <div className="review-heat-hour">{hourLabel(hour, t)}</div>
            {HEATMAP_DAYS_MON_FIRST.map((dow) => {
              const cell = grid[reviewHeatmapIndex(dow, hour)];
              const level = heatmapLevel(cell?.orders ?? 0, thresholds);
              const day = weekdayNames[dow] || String(dow);
              const label = t('adminReview.heatmapTooltip', {
                day,
                hour: hourLabel(hour, t),
                orders: formatNumberMaxDecimals(cell?.orders ?? 0, 0),
                revenue: fmtMoney(cell?.revenue ?? 0),
              });
              return (
                <button
                  key={`${dow}-${hour}`}
                  type="button"
                  className={cn(
                    'review-heat-cell',
                    `review-heat-cell--${level}`,
                  )}
                  title={label}
                  aria-label={label}
                  onMouseEnter={() => setHover(label)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(label)}
                  onBlur={() => setHover(null)}
                />
              );
            })}
          </div>
        ))}
        <div />
        {HEATMAP_DAYS_MON_FIRST.map((dow) => (
          <div key={dow} className="review-heat-day">
            {weekdayNames[dow] || String(dow)}
          </div>
        ))}
      </div>
      {hover ? <div className="review-heat-tip">{hover}</div> : null}
    </div>
  );
}
