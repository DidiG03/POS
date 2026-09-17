import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { IconClose, IconEdit, IconTrash } from '../../components/icons';
import type { TicketLine } from '../../stores/ticket';

function lineAcceptsComment(
  line: { voided?: boolean; staged?: boolean },
  ticketOpen: boolean,
  requestOnly: boolean,
): boolean {
  if (line.voided) return false;
  const dimmed = ticketOpen && !line.staged;
  if (dimmed && !(requestOnly && line.staged)) return false;
  return true;
}

export const TicketLineRow = memo(function TicketLineRow({
  line,
  formatAmount,
  isTableOpen,
  showRequestOnly,
  hasTables,
  selected,
  onToggleSelect,
  onIncrement,
  onDecrement,
  onRemove,
  onVoid,
  onNoteChange,
}: {
  line: TicketLine;
  formatAmount: (n: number) => string;
  isTableOpen: boolean;
  showRequestOnly: boolean;
  hasTables: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onIncrement: (id: string) => void;
  onDecrement: (id: string) => void;
  onRemove: (id: string) => void;
  onVoid: (line: TicketLine) => void;
  onNoteChange: (id: string, note: string) => void;
}) {
  const { t } = useTranslation();
  const dimmed = (isTableOpen && !line.staged) || line.paid === true;
  const isVoided = line.voided === true;
  const isPaid = line.paid === true;
  const canSelect =
    hasTables && lineAcceptsComment(line, isTableOpen, showRequestOnly);
  const canEditNote = hasTables && !isVoided && Boolean(line.staged);
  const hasNote = Boolean(String(line.note || '').trim());
  const showNoteField = hasTables && (hasNote || (canEditNote && selected));
  const noteLocked = Boolean(
    isVoided || (dimmed && !(showRequestOnly && line.staged)),
  );
  const showQtyStepper =
    isTableOpen && !showRequestOnly && Boolean(line.staged) && !isVoided;

  return (
    <div
      role="button"
      tabIndex={canSelect ? 0 : -1}
      className={`ticket-line px-3 py-2.5 transition-shadow ${
        isVoided ? 'opacity-60' : ''
      } ${
        selected
          ? 'ticket-line--selected'
          : canSelect
            ? 'ticket-line--selectable cursor-pointer'
            : ''
      }`}
      onClick={() => {
        if (!canSelect) return;
        onToggleSelect(line.id);
      }}
      onKeyDown={(e) => {
        if (!canSelect) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggleSelect(line.id);
        }
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div
            className={`${dimmed ? 'ticket-line-muted' : ''} font-medium leading-snug ${isVoided ? 'line-through decoration-2' : ''}`}
          >
            {line.name}
            {isPaid ? (
              <span className="ml-2 text-[11px] font-semibold uppercase tracking-wide text-emerald-300">
                {t('order.seatPaid')}
              </span>
            ) : null}
          </div>
        </div>
        <div
          className={`shrink-0 text-[15px] font-semibold tabular-nums ${dimmed ? 'ticket-line-muted' : ''} ${isVoided ? 'line-through decoration-2' : ''}`}
        >
          {formatAmount(line.unitPrice * line.qty)}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex min-h-11 items-center gap-1.5">
          {showQtyStepper ? (
            <>
              <button
                type="button"
                className="ticket-line-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onDecrement(line.id);
                }}
                disabled={line.qty === 1}
              >
                -
              </button>
              <div className="min-w-7 text-center text-[15px] font-semibold tabular-nums">
                {line.qty}
              </div>
              <button
                type="button"
                className="ticket-line-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onIncrement(line.id);
                }}
                disabled={line.qty >= 100}
              >
                +
              </button>
            </>
          ) : (
            <div
              className={`text-[13px] tabular-nums ticket-line-muted ${isVoided ? 'line-through decoration-2' : ''}`}
            >
              ×{line.qty}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {canEditNote ? (
            <button
              type="button"
              className="ticket-line-btn"
              title={t('order.addLineNote')}
              aria-label={t('order.addLineNote')}
              aria-pressed={selected}
              onClick={(e) => {
                e.stopPropagation();
                onToggleSelect(line.id);
              }}
            >
              <IconEdit className="size-4" />
            </button>
          ) : null}
          {isTableOpen && !showRequestOnly ? (
            isVoided ? (
              <div className="w-11" aria-hidden />
            ) : line.staged ? (
              <button
                type="button"
                className="ticket-line-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(line.id);
                }}
                aria-label={t('common.remove')}
              >
                <IconClose className="size-4" />
              </button>
            ) : (
              <button
                type="button"
                className="ticket-line-btn ticket-line-btn--danger"
                disabled={line.paid === true}
                onClick={(e) => {
                  e.stopPropagation();
                  if (line.paid === true) return;
                  onVoid(line);
                }}
                title={
                  line.paid === true
                    ? t('order.voidBlockedPaid')
                    : t('order.voidTitle')
                }
                aria-label={t('order.voidTitle')}
              >
                <IconTrash className="size-4" />
              </button>
            )
          ) : (
            <button
              type="button"
              className="ticket-line-btn"
              disabled={(showRequestOnly && !line.staged) || isVoided}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(line.id);
              }}
              aria-label={t('common.remove')}
            >
              <IconClose className="size-4" />
            </button>
          )}
        </div>
      </div>
      {showNoteField ? (
        <input
          className={`mt-2 w-full pos-input px-2 py-1 ${
            noteLocked ? 'opacity-60 cursor-not-allowed' : ''
          } ${isVoided ? 'line-through decoration-2' : ''}`}
          placeholder={t('order.lineNotePlaceholder')}
          value={line.note ?? ''}
          autoFocus={canEditNote && selected && !hasNote}
          disabled={noteLocked}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onNoteChange(line.id, e.target.value)}
        />
      ) : null}
    </div>
  );
});
