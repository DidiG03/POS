import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { describeTicketNote } from '@shared/utils/transferNote';
import { useSessionStore } from '../../stores/session';
import { useLicenseCapabilities } from '../../stores/licenseCapabilities';
import { receiptLocationTitle, receiptStaffLine } from './reportsReceipt';
import { PageSpinner } from '../../components/PageSpinner';
import { reportAppError } from '../../utils/reportAppError';

type Overview = {
  revenueTodayNet: number;
  revenueTodayVat: number;
  openOrders: number;
  fiscalEnabled?: boolean;
};

/** Same local calendar day as `ref` (default: now). */
function isSameLocalCalendarDay(
  iso: string | null | undefined,
  ref: Date = new Date(),
): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return false;
  return (
    d.getFullYear() === ref.getFullYear() &&
    d.getMonth() === ref.getMonth() &&
    d.getDate() === ref.getDate()
  );
}

export default function ReportsPage() {
  const { t } = useTranslation();
  const { user } = useSessionStore();
  const hasTables = useLicenseCapabilities((s) => s.hasTables);
  const [loading, setLoading] = useState<boolean>(true);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [currency, setCurrency] = useState<string>('EUR');
  const [, setTicketLoading] = useState<boolean>(false);
  const [activeTickets, setActiveTickets] = useState<any[]>([]);
  const [activeTicketsError, setActiveTicketsError] = useState<string | null>(
    null,
  );
  const [paidTickets, setPaidTickets] = useState<any[]>([]);
  const [paidTicketsError, setPaidTicketsError] = useState<string | null>(null);
  const [paidQuery, setPaidQuery] = useState<string>('');
  const [paidLimit, setPaidLimit] = useState<number>(40);
  const [voidedTickets, setVoidedTickets] = useState<any[]>([]);
  const [voidedTicketsError, setVoidedTicketsError] = useState<string | null>(
    null,
  );
  const [ticketsApiMissing, setTicketsApiMissing] = useState<boolean>(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const s = await window.api.settings.get().catch(() => null as any);
        const cur = String((s as any)?.currency || 'EUR').trim() || 'EUR';
        setCurrency(cur);
        if (!user?.id) {
          setOverview(null);
          return;
        }
        const ov = await window.api.reports.getMyOverview(user.id);
        setOverview(ov as any);
      } catch (e: unknown) {
        setOverview(null);
        reportAppError(e, {
          fallback: t('reports.loadFailed'),
          key: `reports.overview:${user?.id || 0}`,
        });
      } finally {
        setLoading(false);
      }
    })();
  }, [user?.id, t]);

  useEffect(() => {
    if (!user?.id) {
      setActiveTickets([]);
      setPaidTickets([]);
      setVoidedTickets([]);
      return;
    }
    if (ticketsApiMissing) return;
    let alive = true;
    const isHidden = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const load = async () => {
      if (isHidden()) return;
      setTicketLoading(true);
      try {
        setActiveTicketsError(null);
        setPaidTicketsError(null);
        setVoidedTicketsError(null);

        const [a, p, v] = await Promise.all([
          hasTables
            ? window.api.reports.listMyActiveTickets(user.id)
            : Promise.resolve([]),
          window.api.reports.listMyPaidTickets({
            userId: user.id,
            q: paidQuery,
            limit: paidLimit,
          }),
          window.api.reports
            .listMyVoidedTickets({ userId: user.id, limit: 40 })
            .catch((err: unknown) => {
              setVoidedTicketsError(
                String(
                  err instanceof Error
                    ? err.message
                    : err || 'Voided list failed',
                ),
              );
              return [];
            }),
        ]);
        if (!alive) return;
        const today = new Date();
        setActiveTickets(Array.isArray(a) ? a : []);
        const paid = Array.isArray(p) ? p : [];
        setPaidTickets(
          paid.filter((t: any) =>
            isSameLocalCalendarDay(t?.paidAt || t?.createdAt, today),
          ),
        );
        const voided = Array.isArray(v) ? v : [];
        setVoidedTickets(
          voided.filter((t: any) =>
            isSameLocalCalendarDay(t?.createdAt, today),
          ),
        );
      } catch (e: any) {
        const msg = String(e?.message || e || '');
        if (
          msg.includes(
            "No handler registered for 'reports:listMyActiveTickets'",
          ) ||
          msg.includes("No handler registered for 'reports:listMyPaidTickets'")
        ) {
          setTicketsApiMissing(true);
        } else {
          // We don't know which one failed (Promise.all), show the message in both panels for visibility.
          setActiveTicketsError(
            msg ||
              t(
                hasTables
                  ? 'reports.failedActive'
                  : 'reports.failedActiveStore',
              ),
          );
          setPaidTicketsError(
            msg ||
              t(hasTables ? 'reports.failedPaid' : 'reports.failedPaidStore'),
          );
          reportAppError(e, {
            fallback: t(
              hasTables ? 'reports.failedActive' : 'reports.failedActiveStore',
            ),
            key: `reports.tickets:${user.id}`,
          });
        }
      } finally {
        if (alive) setTicketLoading(false);
      }
    };
    void load();
    const refreshTimer = setInterval(load, 20000);
    return () => {
      alive = false;
      clearInterval(refreshTimer);
    };
  }, [user?.id, paidQuery, paidLimit, ticketsApiMissing, t, hasTables]);

  const fmtCurrency = useMemo(
    () =>
      new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency || 'EUR',
        maximumFractionDigits: 2,
      }),
    [currency],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden pr-1">
      <div className="mb-4 hidden shrink-0 items-center justify-between sm:flex">
        <h2 className="text-lg font-semibold tracking-tight">
          {t('reports.title')}
        </h2>
      </div>

      {loading ? (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <PageSpinner variant="overlay" message={t('reports.loadingStats')} />
        </div>
      ) : null}

      {!loading && !user && (
        <div className="shrink-0 opacity-70">{t('reports.loginToView')}</div>
      )}

      {!loading && user && overview && (
        <div
          className={`mb-6 grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-2 ${hasTables ? 'lg:grid-cols-3' : ''}`}
        >
          <StatCard
            title={t('reports.revenueTodayNet')}
            value={fmtCurrency.format(overview.revenueTodayNet || 0)}
          />
          <StatCard
            title={t('reports.vatToday')}
            value={fmtCurrency.format(overview.revenueTodayVat || 0)}
          />
          {hasTables ? (
            <StatCard
              title={t('reports.openOrders')}
              value={String(overview.openOrders)}
            />
          ) : null}
        </div>
      )}

      {!loading && (
        <div className="grid shrink-0 grid-cols-1 gap-4 lg:grid-cols-3">
          {/* <div className="lg:col-span-2 p-3 rounded bg-gray-800 border border-gray-700">
            <div className="font-medium mb-2">Sales trend</div>
            … re-enable with getMySalesTrends when this panel is restored …
          </div> */}

          {/* <div className="p-3 rounded bg-gray-800 border border-gray-700">
            <div className="font-medium mb-2">Top selling (today)</div>
            {!topSelling ? (
              <div className="opacity-70 text-sm">No data</div>
            ) : (
              <div className="text-sm">
                <div className="font-semibold">{topSelling.name}</div>
                <div className="opacity-80">Qty: {topSelling.qty}</div>
                <div>Revenue: {fmtCurrency.format(topSelling.revenue)}</div>
              </div>
            )}
          </div> */}
        </div>
      )}

      {/* Tickets: fills remaining viewport; each column scrolls independently on lg+ */}
      {user && (
        <section className="flex min-h-0 flex-1 flex-col">
          <div
            className={`grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto overscroll-contain lg:grid-rows-1 lg:items-stretch lg:overflow-hidden [&>*]:min-h-0 lg:[&>*]:max-h-full ${
              hasTables ? 'lg:grid-cols-3' : 'lg:grid-cols-2'
            }`}
          >
            {hasTables ? (
              <div className="flex min-h-[16rem] flex-col pos-card sm:min-h-[min(28rem,45vh)] lg:min-h-0">
                <div className="mb-2 flex shrink-0 items-center justify-between">
                  <div className="font-medium">
                    {t('reports.activeTickets')}
                  </div>
                  <div className="text-xs opacity-70">
                    {activeTickets.length}
                  </div>
                </div>
                {activeTicketsError && (
                  <div className="pos-alert mb-2 shrink-0 text-xs">
                    {t('reports.activeTicketsError')}{' '}
                    <span className="font-semibold">{activeTicketsError}</span>
                  </div>
                )}
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
                  {activeTickets.length === 0 ? (
                    <div className="text-sm opacity-70">
                      {t('reports.noActiveTickets')}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {activeTickets.map((rec: any, idx: number) => (
                        <ReceiptCard
                          key={`${rec.area}:${rec.tableLabel}:${rec.createdAt}:${idx}`}
                          ticket={rec}
                          fmtCurrency={fmtCurrency}
                          hasTables={hasTables}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            <div className="flex min-h-[16rem] flex-col pos-card sm:min-h-[min(28rem,45vh)] lg:min-h-0">
              <div className="mb-2 flex shrink-0 items-center justify-between">
                <div className="font-medium">
                  {t(
                    hasTables ? 'reports.paidToday' : 'reports.paidSalesToday',
                  )}
                </div>
                <div className="text-xs opacity-70">{paidTickets.length}</div>
              </div>
              {paidTicketsError && (
                <div className="pos-alert mb-2 shrink-0 text-xs">
                  {t(
                    hasTables
                      ? 'reports.paidTicketsError'
                      : 'reports.paidSalesError',
                  )}{' '}
                  <span className="font-semibold">{paidTicketsError}</span>
                </div>
              )}
              <div className="mb-3 flex shrink-0 items-center gap-2">
                <input
                  className="pos-input min-w-0 flex-1"
                  placeholder={t(
                    hasTables
                      ? 'reports.searchPlaceholder'
                      : 'reports.searchPlaceholderStore',
                  )}
                  value={paidQuery}
                  onChange={(e) => setPaidQuery(e.target.value)}
                />
                <select
                  className="pos-input w-auto shrink-0"
                  value={String(paidLimit)}
                  onChange={(e) => setPaidLimit(Number(e.target.value))}
                >
                  <option value="20">20</option>
                  <option value="40">40</option>
                  <option value="80">80</option>
                  <option value="120">120</option>
                </select>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
                {paidTickets.length === 0 ? (
                  <div className="text-sm opacity-70">
                    {t(
                      hasTables
                        ? 'reports.noPaidToday'
                        : 'reports.noPaidSalesToday',
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {paidTickets.map((rec: any, idx: number) => (
                      <ReceiptCard
                        key={`${rec.area}:${rec.tableLabel}:${rec.createdAt}:${idx}`}
                        ticket={rec}
                        fmtCurrency={fmtCurrency}
                        hasTables={hasTables}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex min-h-[16rem] flex-col pos-card sm:min-h-[min(28rem,45vh)] lg:min-h-0">
              <div className="mb-2 flex shrink-0 items-center justify-between">
                <div className="font-medium">
                  {t(
                    hasTables
                      ? 'reports.voidedToday'
                      : 'reports.voidedSalesToday',
                  )}
                </div>
                <div className="text-xs opacity-70">{voidedTickets.length}</div>
              </div>
              {voidedTicketsError && (
                <div className="pos-alert mb-2 shrink-0 text-xs">
                  {voidedTicketsError}
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
                {voidedTickets.length === 0 ? (
                  <div className="text-sm opacity-70">
                    {t('reports.nothingVoided')}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {voidedTickets.map((rec: any, idx: number) => (
                      <VoidedReceiptCard
                        key={`void-${rec.area}:${rec.tableLabel}:${rec.createdAt}:${idx}`}
                        ticket={rec}
                        fmtCurrency={fmtCurrency}
                        hasTables={hasTables}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function TicketNoteLines({
  note,
  hasTables,
}: {
  note: string;
  hasTables: boolean;
}) {
  const { t } = useTranslation();
  const { history, userNote } = describeTicketNote(note);
  const lines = hasTables ? history : [];
  if (lines.length === 0 && !userNote) return null;
  return (
    <div className="text-xs mb-2 space-y-0.5">
      {lines.map((line, i) => (
        <div key={`${line}-${i}`}>{line}</div>
      ))}
      {userNote ? (
        <div>
          <span className="font-semibold">{t('common.note')}:</span> {userNote}
        </div>
      ) : null}
    </div>
  );
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="pos-stat">
      <div className="pos-section-label">{title}</div>
      <div className="text-xl mt-1.5 font-semibold tabular-nums tracking-tight text-gray-50">
        {value}
      </div>
    </div>
  );
}

function ReceiptCard({
  ticket,
  fmtCurrency,
  hasTables,
}: {
  ticket: any;
  fmtCurrency: Intl.NumberFormat;
  hasTables: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<boolean>(false);
  const items = Array.isArray(ticket?.items) ? ticket.items : [];
  const createdAt = ticket?.paidAt || ticket?.createdAt;
  const when = createdAt ? new Date(createdAt) : null;
  const headerRight =
    ticket?.kind === 'PAID'
      ? `${String(ticket?.paymentMethod || 'PAID')}${when ? ` • ${when.toLocaleString()}` : ''}`
      : `${when ? when.toLocaleString() : ''}`;
  const serviceChargeAmount = Number(ticket?.serviceChargeAmount || 0);
  const hasServiceCharge =
    hasTables &&
    Number.isFinite(serviceChargeAmount) &&
    serviceChargeAmount > 0;
  const discountAmount = Number(ticket?.discountAmount || 0);
  const hasDiscount = Number.isFinite(discountAmount) && discountAmount > 0;
  const discountLabel = (() => {
    const dm = String(ticket?.discountType || '').toUpperCase();
    const v = ticket?.discountValue;
    if (dm === 'PERCENT' && Number.isFinite(Number(v))) return `${Number(v)}%`;
    if (dm === 'AMOUNT' && Number.isFinite(Number(v)))
      return fmtCurrency.format(Number(v));
    return null;
  })();
  const serviceLabel = (() => {
    const sm = String(ticket?.serviceChargeMode || '').toUpperCase();
    const v = ticket?.serviceChargeValue;
    if (sm === 'PERCENT' && Number.isFinite(Number(v))) return `${Number(v)}%`;
    return null;
  })();

  return (
    <div className="ticket-line overflow-hidden">
      <button
        className="flex w-full items-start justify-between gap-3 border-b border-[var(--pos-border)] px-3 py-2.5 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            {receiptLocationTitle(t, hasTables, ticket)}
            <span className="ml-2 text-xs font-normal text-[color:var(--pos-fg-muted)]">
              {ticket?.kind === 'PAID' ? t('common.paid') : t('common.active')}
            </span>
          </div>
          <div className="text-xs text-[color:var(--pos-fg-muted)]">
            {receiptStaffLine(t, hasTables, ticket?.userName)}
            {hasTables && ticket?.covers != null
              ? ` • ${t('common.covers')}: ${ticket.covers}`
              : ''}
          </div>
        </div>
        <div className="max-w-[46%] text-right text-xs leading-snug text-[color:var(--pos-fg-muted)] sm:max-w-none sm:whitespace-nowrap">
          {headerRight}
        </div>
      </button>

      {open && (
        <div className="px-3 py-2 font-mono">
          {ticket?.note ? (
            <TicketNoteLines note={String(ticket.note)} hasTables={hasTables} />
          ) : null}

          <div className="border-t border-[var(--pos-border)] pt-2">
            {items.length === 0 ? (
              <div className="text-xs text-[color:var(--pos-fg-muted)]">
                {t('common.noItems')}
              </div>
            ) : (
              <div className="space-y-1">
                {items.map((it: any, idx: number) => {
                  const qty = Number(it?.qty || 1);
                  const name = String(it?.name || t('common.item'));
                  const unit = Number(it?.unitPrice || 0);
                  const line = unit * qty;
                  return (
                    <div
                      key={idx}
                      className="flex items-start justify-between gap-3 text-xs"
                    >
                      <div className="flex-1">
                        <div className="flex items-baseline gap-2">
                          <div className="font-semibold">{qty}x</div>
                          <div className="break-words">{name}</div>
                        </div>
                        <div className="text-[11px] text-[color:var(--pos-fg-muted)]">
                          {fmtCurrency.format(unit)} {t('common.each')}
                        </div>
                      </div>
                      <div className="whitespace-nowrap">
                        {fmtCurrency.format(line)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-2 space-y-1 border-t border-[var(--pos-border)] pt-2 text-xs">
            <div className="flex justify-between">
              <span className="text-[color:var(--pos-fg-muted)]">
                {t('common.subtotal')}
              </span>
              <span className="font-semibold">
                {fmtCurrency.format(Number(ticket?.subtotal || 0))}
              </span>
            </div>
            {ticket?.vatEnabled === false ? (
              <div className="flex justify-between">
                <span className="text-[color:var(--pos-fg-muted)]">
                  {t('common.vat')}
                </span>
                <span className="opacity-70">{t('common.vatDisabled')}</span>
              </div>
            ) : (
              <div className="flex justify-between">
                <span className="text-[color:var(--pos-fg-muted)]">
                  {t('common.vat')}
                </span>
                <span className="font-semibold">
                  {fmtCurrency.format(Number(ticket?.vat || 0))}
                </span>
              </div>
            )}
            {hasServiceCharge && (
              <div className="flex justify-between">
                <span className="text-[color:var(--pos-fg-muted)]">
                  {t('common.serviceCharge')}
                  {serviceLabel ? ` (${serviceLabel})` : ''}
                </span>
                <span className="font-semibold">
                  {fmtCurrency.format(serviceChargeAmount)}
                </span>
              </div>
            )}
            {hasDiscount && (
              <div className="flex justify-between">
                <span className="text-[color:var(--pos-fg-muted)]">
                  {t('common.discount')}
                  {discountLabel ? ` (${discountLabel})` : ''}
                </span>
                <span className="font-semibold">
                  -{fmtCurrency.format(discountAmount)}
                </span>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="font-semibold">
                {hasDiscount
                  ? t('reports.totalAfterDiscountReceipt')
                  : t('common.total')}
              </span>
              <span className="font-semibold">
                {fmtCurrency.format(Number(ticket?.total || 0))}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function VoidedReceiptCard({
  ticket,
  fmtCurrency,
  hasTables,
}: {
  ticket: any;
  fmtCurrency: Intl.NumberFormat;
  hasTables: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<boolean>(false);
  const items = Array.isArray(ticket?.items) ? ticket.items : [];
  const voidCount = Number(ticket?.voidedCount || items.length || 0);
  const when = ticket?.createdAt ? new Date(ticket.createdAt) : null;
  const isFullVoid = ticket?.kind === 'VOIDED_TICKET';

  return (
    <div className="pos-alert overflow-hidden !p-0">
      <button
        className="flex w-full items-start justify-between gap-3 border-b border-[var(--pos-border)] px-3 py-2.5 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-semibold">
            {receiptLocationTitle(t, hasTables, ticket)}
            <span
              className={`rounded-md px-2 py-0.5 text-xs font-medium ${isFullVoid ? 'bg-rose-600/20 text-rose-300' : 'bg-amber-500/20 text-amber-300'}`}
            >
              {isFullVoid
                ? t('common.fullyVoided')
                : voidCount === 1
                  ? t('reports.voidedOneItem', { count: voidCount })
                  : t('reports.voidedManyItems', { count: voidCount })}
            </span>
          </div>
          <div className="text-xs text-[color:var(--pos-fg-muted)]">
            {receiptStaffLine(t, hasTables, ticket?.userName)}
            {hasTables && ticket?.covers != null
              ? ` • ${t('common.covers')}: ${ticket.covers}`
              : ''}
          </div>
        </div>
        <div className="max-w-[46%] text-right text-xs leading-snug text-[color:var(--pos-fg-muted)] sm:max-w-none sm:whitespace-nowrap">
          {when ? when.toLocaleString() : ''}
        </div>
      </button>

      {open && (
        <div className="px-3 py-2 font-mono">
          {ticket?.note ? (
            <TicketNoteLines note={String(ticket.note)} hasTables={hasTables} />
          ) : null}

          <div className="border-t border-[var(--pos-border)] pt-2">
            {items.length === 0 ? (
              <div className="text-xs text-[color:var(--pos-fg-muted)]">
                {t('common.noItems')}
              </div>
            ) : (
              <div className="space-y-1">
                {items.map((it: any, idx: number) => {
                  const qty = Number(it?.qty || 1);
                  const name = String(it?.name || t('common.item'));
                  const unit = Number(it?.unitPrice || 0);
                  const line = unit * qty;
                  return (
                    <div
                      key={idx}
                      className="flex items-start justify-between gap-3 text-xs"
                    >
                      <div className="flex-1">
                        <div className="flex items-baseline gap-2">
                          <div className="font-semibold line-through opacity-70">
                            {qty}x
                          </div>
                          <div className="break-words line-through opacity-70">
                            {name}
                          </div>
                        </div>
                        <div className="text-[11px] text-[color:var(--pos-fg-muted)]">
                          {fmtCurrency.format(unit)} {t('common.each')}
                        </div>
                      </div>
                      <div className="whitespace-nowrap line-through opacity-70">
                        {fmtCurrency.format(line)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-2 border-t border-[var(--pos-border)] pt-2 text-xs">
            <div className="flex justify-between">
              <span className="text-[color:var(--pos-fg-muted)]">
                {t('common.voidedTotal')}
              </span>
              <span className="font-semibold text-rose-300">
                {fmtCurrency.format(Number(ticket?.subtotal || 0))}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
