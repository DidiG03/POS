/**
 * The fiscal review list as a guided fix (Admin): each sale with its
 * reason in plain words, and the steps for its kind:
 *   - refused / never sent: fix the cause, then "Send again";
 *   - outcome unknown: look the docId up in easyPos, then say what was
 *     found (filed, with its codes; or not there, then it is sent again);
 *   - changed after filing: issue the correction, then mark it done.
 * Every decision needs a short note; it is kept in the security log with
 * who made it.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../components/ui/Modal';
import { plainReviewReason } from '@shared/statusLights';
import { toast } from '../../stores/toasts';

type Row = {
  idempotencyKey: string;
  kind: string;
  area: string | null;
  tableLabel: string | null;
  total: number | null;
  lastError: string | null;
  createdAt: string;
};

export function FiscalReviewDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [found, setFound] = useState<'filed' | 'missing' | null>(null);
  const [nslf, setNslf] = useState('');
  const [nivf, setNivf] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const all: Row[] =
      (await (window as any).api.settings.listFiscalReviews?.()) ?? [];
    setRows(all.filter((r) => r.kind !== 'deferred'));
  }, []);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const resolve = async (row: Row, input: Record<string, unknown>) => {
    if (note.trim().length < 3) {
      toast.warn(t('reviews.noteRequired'));
      return;
    }
    setBusy(true);
    try {
      const r = await (window as any).api.settings.resolveFiscalReview({
        idempotencyKey: row.idempotencyKey,
        note: note.trim(),
        ...input,
      });
      if (!r?.ok) toast.error(r?.error || t('reviews.failed'));
      else {
        toast.success(t('reviews.done'));
        setActive(null);
        setNote('');
        setFound(null);
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('reviews.title', { count: rows.length })}
    >
      {rows.length === 0 ? (
        <p className="text-[13px]">{t('reviews.none')}</p>
      ) : (
        <ul
          className="max-h-[60vh] space-y-2 overflow-auto"
          data-testid="review-list"
        >
          {rows.map((r) => (
            <li
              key={r.idempotencyKey}
              className="rounded-lg border border-white/10 p-3 text-[13px]"
            >
              <div className="font-semibold">
                {[r.area, r.tableLabel].filter(Boolean).join(' · ') ||
                  t('reviews.sale')}
                {r.total != null ? ` · ${r.total}` : ''} ·{' '}
                <span className="font-normal text-[color:var(--pos-fg-muted)]">
                  {new Date(r.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="mt-1">
                {plainReviewReason(r.kind, r.lastError)}
              </div>
              <div className="mt-1 text-[11px] text-[color:var(--pos-fg-muted)]">
                docId {r.idempotencyKey}
              </div>
              {active !== r.idempotencyKey ? (
                <button
                  type="button"
                  className="pos-btn mt-2"
                  onClick={() => setActive(r.idempotencyKey)}
                >
                  {t('reviews.fix')}
                </button>
              ) : (
                <div className="mt-2 space-y-2">
                  <textarea
                    className="pos-input w-full"
                    rows={2}
                    placeholder={t('reviews.notePlaceholder')}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  {r.kind === 'unknown-outcome' || r.kind === 'unrecorded' ? (
                    <>
                      <div>{t('reviews.lookUp')}</div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="pos-btn"
                          onClick={() => setFound('filed')}
                        >
                          {t('reviews.itIsThere')}
                        </button>
                        <button
                          type="button"
                          className="pos-btn"
                          onClick={() => setFound('missing')}
                        >
                          {t('reviews.notThere')}
                        </button>
                      </div>
                      {found === 'filed' ? (
                        <div className="flex flex-wrap gap-2">
                          <input
                            className="pos-input"
                            placeholder="NSLF"
                            value={nslf}
                            onChange={(e) => setNslf(e.target.value)}
                          />
                          <input
                            className="pos-input"
                            placeholder="NIVF"
                            value={nivf}
                            onChange={(e) => setNivf(e.target.value)}
                          />
                          <button
                            type="button"
                            className="pos-btn"
                            disabled={busy || !nivf.trim()}
                            onClick={() =>
                              void resolve(r, {
                                resolution: 'registered',
                                nslf: nslf.trim(),
                                nivf: nivf.trim(),
                              })
                            }
                          >
                            {t('reviews.saveCodes')}
                          </button>
                        </div>
                      ) : found === 'missing' ? (
                        <button
                          type="button"
                          className="pos-btn"
                          disabled={busy}
                          onClick={() =>
                            void resolve(r, {
                              resolution: 'retry',
                              confirmedNotFiled: true,
                            })
                          }
                        >
                          {t('reviews.sendAgain')}
                        </button>
                      ) : null}
                    </>
                  ) : r.kind === 'correction-required' ? (
                    <button
                      type="button"
                      className="pos-btn"
                      disabled={busy}
                      onClick={() =>
                        void resolve(r, { resolution: 'corrected' })
                      }
                    >
                      {t('reviews.markCorrected')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="pos-btn"
                      disabled={busy}
                      onClick={() => void resolve(r, { resolution: 'retry' })}
                    >
                      {t('reviews.sendAgain')}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
