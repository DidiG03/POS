/** The floor's legend: each table state's colour, icon and word. */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { TABLE_STATE_LOOK, type TableFloorState } from '@shared/tableState';

const ORDER: TableFloorState[] = [
  'seated',
  'ordered',
  'served',
  'billRequested',
  'paid',
];

export const TableStateLegend = memo(function TableStateLegend() {
  const { t } = useTranslation();
  return (
    <ul
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-2 text-[11px] text-[color:var(--pos-fg-muted)]"
      aria-label={t('tables.legend')}
      data-testid="table-legend"
    >
      {ORDER.map((s) => (
        <li key={s} className="flex items-center gap-1">
          <span
            aria-hidden
            className={`inline-flex h-4 w-4 items-center justify-center rounded text-[10px] text-white ${TABLE_STATE_LOOK[s].cls}`}
          >
            {TABLE_STATE_LOOK[s].icon}
          </span>
          {t(`tables.state.${s}`)}
        </li>
      ))}
      <li className="flex items-center gap-1">
        <span
          aria-hidden
          className="inline-block h-4 w-4 rounded ring-2 ring-red-500"
        />
        {t('tables.state.idle')}
      </li>
    </ul>
  );
});
