import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/session';

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
  const [loading, setLoading] = useState<boolean>(true);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [currency, setCurrency] = useState<string>('EUR');
  const [ticketLoading, setTicketLoading] = useState<boolean>(false);
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
      } finally {
        setLoading(false);
      }
    })();
  }, [user?.id]);

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
          window.api.reports.listMyActiveTickets(user.id),
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
          setActiveTicketsError(msg || t('reports.failedActive'));
          setPaidTicketsError(msg || t('reports.failedPaid'));
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
  }, [user?.id, paidQuery, paidLimit, ticketsApiMissing, t]);

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
      <div className="flex shrink-0 items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">{t('reports.title')}</h2>
      </div>

      {loading && (
        <div className="shrink-0 opacity-70">{t('reports.loadingStats')}</div>
      )}

      {!loading && !user && (
        <div className="shrink-0 opacity-70">{t('reports.loginToView')}</div>
      )}

      {!loading && user && overview && (
        <div className="mb-6 grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            title={t('reports.revenueTodayNet')}
            value={fmtCurrency.format(overview.revenueTodayNet || 0)}
          />
          <StatCard
            title={t('reports.vatToday')}
            value={fmtCurrency.format(overview.revenueTodayVat || 0)}
          />
          <StatCard
            title={t('reports.openOrders')}
            value={String(overview.openOrders)}
          />
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
          <div className="mb-3 flex shrink-0 items-center justify-between">
            <div className="text-base font-semibold">
              {t('reports.tickets')}
            </div>
            <div className="text-xs opacity-70">
              {ticketsApiMissing
                ? t('reports.updateRequired')
                : ticketLoading
                  ? t('reports.refreshing')
                  : t('reports.autoRefresh')}
            </div>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-3 lg:grid-rows-1 lg:items-stretch [&>*]:min-h-0 lg:[&>*]:max-h-full">
            <div className="flex min-h-[min(28rem,45vh)] flex-col rounded border border-gray-700 bg-gray-800 p-3 lg:min-h-0">
              <div className="mb-2 flex shrink-0 items-center justify-between">
                <div className="font-medium">{t('reports.activeTickets')}</div>
                <div className="text-xs opacity-70">{activeTickets.length}</div>
              </div>
              {activeTicketsError && (
                <div className="mb-2 shrink-0 rounded border border-rose-800 bg-rose-900/30 px-3 py-2 text-xs text-rose-200">
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
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex min-h-[min(28rem,45vh)] flex-col rounded border border-gray-700 bg-gray-800 p-3 lg:min-h-0">
              <div className="mb-2 flex shrink-0 items-center justify-between">
                <div className="font-medium">{t('reports.paidToday')}</div>
                <div className="text-xs opacity-70">{paidTickets.length}</div>
              </div>
              {paidTicketsError && (
                <div className="mb-2 shrink-0 rounded border border-rose-800 bg-rose-900/30 px-3 py-2 text-xs text-rose-200">
                  {t('reports.paidTicketsError')}{' '}
                  <span className="font-semibold">{paidTicketsError}</span>
                </div>
              )}
              <div className="mb-3 flex shrink-0 items-center gap-2">
                <input
                  className="flex-1 rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                  placeholder={t('reports.searchPlaceholder')}
                  value={paidQuery}
                  onChange={(e) => setPaidQuery(e.target.value)}
                />
                <select
                  className="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
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
                    {t('reports.noPaidToday')}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {paidTickets.map((rec: any, idx: number) => (
                      <ReceiptCard
                        key={`${rec.area}:${rec.tableLabel}:${rec.createdAt}:${idx}`}
                        ticket={rec}
                        fmtCurrency={fmtCurrency}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex min-h-[min(28rem,45vh)] flex-col rounded border border-gray-700 bg-gray-800 p-3 lg:min-h-0">
              <div className="mb-2 flex shrink-0 items-center justify-between">
                <div className="font-medium">{t('reports.voidedToday')}</div>
                <div className="text-xs opacity-70">{voidedTickets.length}</div>
              </div>
              {voidedTicketsError && (
                <div className="mb-2 shrink-0 rounded border border-rose-800 bg-rose-900/30 px-3 py-2 text-xs text-rose-200">
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

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="p-3 rounded bg-gray-800 border border-gray-700">
      <div className="text-xs opacity-70">{title}</div>
      <div className="text-lg mt-1">{value}</div>
    </div>
  );
}

function ReceiptCard({
  ticket,
  fmtCurrency,
}: {
  ticket: any;
  fmtCurrency: Intl.NumberFormat;
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
    Number.isFinite(serviceChargeAmount) && serviceChargeAmount > 0;
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
    <div className="rounded border border-gray-700 bg-white text-black overflow-hidden">
      <button
        className="w-full text-left px-3 py-2 border-b border-gray-200 flex items-start justify-between gap-3"
        onClick={() => setOpen((v) => !v)}
      >
        <div>
          <div className="font-semibold text-sm">
            {ticket?.area ? `${ticket.area} • ` : ''}
            {t('reports.receiptTable', {
              label: String(ticket?.tableLabel ?? ''),
            })}
            <span className="ml-2 text-xs font-normal text-gray-600">
              {ticket?.kind === 'PAID' ? t('common.paid') : t('common.active')}
            </span>
          </div>
          <div className="text-xs text-gray-600">
            {ticket?.userName
              ? t('common.waiterWithName', {
                  name: String(ticket.userName),
                })
              : `${t('common.waiter')}: —`}
            {ticket?.covers != null
              ? ` • ${t('common.covers')}: ${ticket.covers}`
              : ''}
          </div>
        </div>
        <div className="text-xs text-gray-600 whitespace-nowrap">
          {headerRight}
        </div>
      </button>

      {open && (
        <div className="px-3 py-2 font-mono">
          {ticket?.note ? (
            <div className="text-xs mb-2">
              <span className="font-semibold">{t('common.note')}:</span>{' '}
              {String(ticket.note)}
            </div>
          ) : null}

          <div className="border-t border-gray-200 pt-2">
            {items.length === 0 ? (
              <div className="text-xs text-gray-600">{t('common.noItems')}</div>
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
                        <div className="text-[11px] text-gray-600">
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

          <div className="border-t border-gray-200 mt-2 pt-2 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-gray-700">{t('common.subtotal')}</span>
              <span className="font-semibold">
                {fmtCurrency.format(Number(ticket?.subtotal || 0))}
              </span>
            </div>
            {ticket?.vatEnabled === false ? (
              <div className="flex justify-between">
                <span className="text-gray-700">{t('common.vat')}</span>
                <span className="opacity-70">{t('common.vatDisabled')}</span>
              </div>
            ) : (
              <div className="flex justify-between">
                <span className="text-gray-700">{t('common.vat')}</span>
                <span className="font-semibold">
                  {fmtCurrency.format(Number(ticket?.vat || 0))}
                </span>
              </div>
            )}
            {hasServiceCharge && (
              <div className="flex justify-between">
                <span className="text-gray-700">
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
                <span className="text-gray-700">
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
}: {
  ticket: any;
  fmtCurrency: Intl.NumberFormat;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<boolean>(false);
  const items = Array.isArray(ticket?.items) ? ticket.items : [];
  const voidCount = Number(ticket?.voidedCount || items.length || 0);
  const when = ticket?.createdAt ? new Date(ticket.createdAt) : null;
  const isFullVoid = ticket?.kind === 'VOIDED_TICKET';

  return (
    <div className="rounded border border-rose-800/60 bg-rose-950/30 text-gray-100 overflow-hidden">
      <button
        className="w-full text-left px-3 py-2 border-b border-rose-800/40 flex items-start justify-between gap-3"
        onClick={() => setOpen((v) => !v)}
      >
        <div>
          <div className="font-semibold text-sm flex items-center gap-2">
            {ticket?.area ? `${ticket.area} • ` : ''}
            {t('reports.receiptTable', {
              label: String(ticket?.tableLabel ?? ''),
            })}
            <span
              className={`text-xs font-normal px-2 py-0.5 rounded ${isFullVoid ? 'bg-rose-700/60 text-rose-100' : 'bg-amber-700/60 text-amber-100'}`}
            >
              {isFullVoid
                ? t('common.fullyVoided')
                : voidCount === 1
                  ? t('reports.voidedOneItem', { count: voidCount })
                  : t('reports.voidedManyItems', { count: voidCount })}
            </span>
          </div>
          <div className="text-xs text-gray-400">
            {ticket?.userName
              ? t('common.waiterWithName', {
                  name: String(ticket.userName),
                })
              : `${t('common.waiter')}: —`}
            {ticket?.covers != null
              ? ` • ${t('common.covers')}: ${ticket.covers}`
              : ''}
          </div>
        </div>
        <div className="text-xs text-gray-400 whitespace-nowrap">
          {when ? when.toLocaleString() : ''}
        </div>
      </button>

      {open && (
        <div className="px-3 py-2 font-mono">
          {ticket?.note ? (
            <div className="text-xs mb-2">
              <span className="font-semibold">{t('common.note')}:</span>{' '}
              {String(ticket.note)}
            </div>
          ) : null}

          <div className="border-t border-rose-800/40 pt-2">
            {items.length === 0 ? (
              <div className="text-xs text-gray-400">{t('common.noItems')}</div>
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
                        <div className="text-[11px] text-gray-500">
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

          <div className="border-t border-rose-800/40 mt-2 pt-2 text-xs">
            <div className="flex justify-between">
              <span className="text-gray-400">{t('common.voidedTotal')}</span>
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
