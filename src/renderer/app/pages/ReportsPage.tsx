import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { describeTicketNote } from '@shared/utils/transferNote';
import { useSessionStore } from '../../stores/session';
import { useLicenseCapabilities } from '../../stores/licenseCapabilities';
import {
  buildReportPrintPayload,
  receiptLocationTitle,
  receiptStaffLine,
  reportTicketShowsFiscal,
  reportTicketVerifyUrl,
} from './reportsReceipt';
import { printTicket } from '../../api';
import { toast } from '../../stores/toasts';
import { PageSpinner } from '../../components/PageSpinner';
import { reportAppError } from '../../utils/reportAppError';
import { IconPrinter } from '../../components/icons';
import { FiscalVerifyQr } from '../../components/FiscalVerifyQr';
import { isFiscalPending, isFiscalRegistered } from '@shared/fiscalReceipt';
import { convertPosAmount, parseEurExchangeRate } from '@shared/paymentDisplay';
import { formatEur } from '../../utils/format';

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
  const [eurExchangeRate, setEurExchangeRate] = useState<number | null>(null);
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
  const [printingDay, setPrintingDay] = useState(false);
  const [ticketsApiMissing, setTicketsApiMissing] = useState<boolean>(false);
  const [captureClockInOut, setCaptureClockInOut] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const s = await window.api.settings.get().catch(() => null as any);
        const cur = String((s as any)?.currency || 'EUR').trim() || 'EUR';
        setCurrency(cur);
        setEurExchangeRate(
          parseEurExchangeRate((s as any)?.fiscal?.eurExchangeRate),
        );
        setCaptureClockInOut(
          (s as any)?.preferences?.captureClockInOut !== false,
        );
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
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto overscroll-contain pr-1 lg:overflow-hidden">
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
          className={`mb-4 grid shrink-0 gap-2 sm:mb-6 sm:gap-3 ${
            hasTables ? 'grid-cols-3' : 'grid-cols-2'
          }`}
        >
          <StatCard
            title={t('reports.revenueTodayNet')}
            value={fmtCurrency.format(overview.revenueTodayNet || 0)}
            compact
          />
          <StatCard
            title={t('reports.vatToday')}
            value={fmtCurrency.format(overview.revenueTodayVat || 0)}
            compact
          />
          {hasTables ? (
            <StatCard
              title={t('reports.openOrders')}
              value={String(overview.openOrders)}
              compact
            />
          ) : null}
        </div>
      )}

      {/* Phone: one page scroll, full-height ticket lists. Desktop: three
          independent columns that fill the remaining viewport. */}
      {user && (
        <section className="flex flex-col pb-[max(1rem,env(safe-area-inset-bottom))] lg:min-h-0 lg:flex-1 lg:pb-0">
          {hasTables && !captureClockInOut ? (
            <div className="mb-3 shrink-0">
              <button
                type="button"
                className="pos-btn-primary flex w-full items-center justify-center gap-2 py-3 text-sm font-semibold"
                disabled={printingDay || !user?.id}
                onClick={() => {
                  if (!user?.id || printingDay) return;
                  setPrintingDay(true);
                  void window.api.reports
                    .printMyDaySummary(user.id)
                    .then((r) => {
                      if (r?.ok) {
                        toast.success(t('reports.daySummaryPrinted'));
                      } else {
                        toast.error(
                          String(r?.error || t('reports.daySummaryFailed')),
                        );
                      }
                    })
                    .catch((e: unknown) => {
                      reportAppError(e, {
                        fallback: t('reports.daySummaryFailed'),
                        key: `reports.daySummary:${user.id}`,
                      });
                      toast.error(t('reports.daySummaryFailed'));
                    })
                    .finally(() => setPrintingDay(false));
                }}
              >
                <IconPrinter className="size-4" />
                {printingDay
                  ? t('reports.printingDaySummary')
                  : t('reports.printDaySummary')}
              </button>
            </div>
          ) : null}
          <div
            className={`grid grid-cols-1 gap-4 lg:min-h-0 lg:flex-1 lg:grid-rows-1 lg:items-stretch lg:overflow-hidden lg:[&>*]:min-h-0 lg:[&>*]:max-h-full ${
              hasTables ? 'lg:grid-cols-3' : 'lg:grid-cols-2'
            }`}
          >
            {hasTables ? (
              <TicketPanel
                title={t('reports.activeTickets')}
                count={activeTickets.length}
                error={
                  activeTicketsError
                    ? `${t('reports.activeTicketsError')} ${activeTicketsError}`
                    : null
                }
              >
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
                        posCurrency={currency}
                        eurExchangeRate={eurExchangeRate}
                      />
                    ))}
                  </div>
                )}
              </TicketPanel>
            ) : null}

            <TicketPanel
              title={t(
                hasTables ? 'reports.paidToday' : 'reports.paidSalesToday',
              )}
              count={paidTickets.length}
              error={
                paidTicketsError
                  ? `${t(
                      hasTables
                        ? 'reports.paidTicketsError'
                        : 'reports.paidSalesError',
                    )} ${paidTicketsError}`
                  : null
              }
              toolbar={
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
                    className="pos-input w-full shrink-0 sm:w-auto"
                    value={String(paidLimit)}
                    onChange={(e) => setPaidLimit(Number(e.target.value))}
                    aria-label={t('reports.paidToday')}
                  >
                    <option value="20">20</option>
                    <option value="40">40</option>
                    <option value="80">80</option>
                    <option value="120">120</option>
                  </select>
                </div>
              }
            >
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
                      posCurrency={currency}
                      eurExchangeRate={eurExchangeRate}
                    />
                  ))}
                </div>
              )}
            </TicketPanel>

            <TicketPanel
              title={t(
                hasTables ? 'reports.voidedToday' : 'reports.voidedSalesToday',
              )}
              count={voidedTickets.length}
              error={voidedTicketsError}
            >
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
            </TicketPanel>
          </div>
        </section>
      )}
    </div>
  );
}

function TicketPanel({
  title,
  count,
  error,
  toolbar,
  children,
}: {
  title: string;
  count: number;
  error?: string | null;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col pos-card lg:min-h-0">
      <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
        <div className="font-medium">{title}</div>
        <div className="text-xs opacity-70 tabular-nums">{count}</div>
      </div>
      {error ? (
        <div className="pos-alert mb-2 shrink-0 text-xs">
          <span className="font-semibold">{error}</span>
        </div>
      ) : null}
      {toolbar ? <div className="mb-3 shrink-0">{toolbar}</div> : null}
      {/* Nested scroll only on large screens; phones scroll the whole page. */}
      <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain lg:pr-1">
        {children}
      </div>
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
    <div className="mb-2 space-y-0.5 text-[15px] font-light leading-snug">
      {lines.map((line, i) => (
        <div key={`${line}-${i}`}>{line}</div>
      ))}
      {userNote ? (
        <div>
          <span className="font-medium">{t('common.note')}:</span> {userNote}
        </div>
      ) : null}
    </div>
  );
}

function StatCard({
  title,
  value,
  compact = false,
}: {
  title: string;
  value: string;
  compact?: boolean;
}) {
  return (
    <div className={`pos-stat ${compact ? 'p-2.5 sm:p-3.5' : ''}`}>
      <div
        className={`pos-section-label ${compact ? 'line-clamp-2 text-[10px] leading-tight sm:text-[11px]' : ''}`}
      >
        {title}
      </div>
      <div
        className={`mt-1 font-semibold tabular-nums tracking-tight text-gray-50 sm:mt-1.5 ${
          compact ? 'text-base leading-tight sm:text-xl' : 'text-xl'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function ReceiptCard({
  ticket,
  fmtCurrency,
  hasTables,
  posCurrency,
  eurExchangeRate,
}: {
  ticket: any;
  fmtCurrency: Intl.NumberFormat;
  hasTables: boolean;
  posCurrency?: string;
  eurExchangeRate?: number | null;
}) {
  const { t } = useTranslation();
  const { user } = useSessionStore();
  const [open, setOpen] = useState<boolean>(false);
  const [printing, setPrinting] = useState(false);
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

  const canPrint = Boolean(buildReportPrintPayload(ticket, {}));
  const ticketTotal = Number(ticket?.total || 0);
  const eurTotal =
    ticket?.kind === 'PAID'
      ? convertPosAmount(
          ticketTotal,
          String(posCurrency || 'ALL'),
          eurExchangeRate ?? null,
        ).eur
      : null;

  const onPrint = async () => {
    const payload = buildReportPrintPayload(ticket, {
      userId: user?.id,
      userName: user?.displayName || ticket?.userName,
    });
    if (!payload || printing) return;
    setPrinting(true);
    try {
      const printed = await printTicket(payload);
      if (printed?.queued) {
        toast.warn(t('order.ticketPrintQueued'));
      } else {
        toast.success(t('reports.ticketPrinted'));
      }
    } catch (e: unknown) {
      reportAppError(e, {
        fallback: t('reports.printTicketFailed'),
        key: `reports.print:${ticket?.area}:${ticket?.tableLabel}`,
      });
      toast.warn(t('order.ticketPrintQueued'));
    } finally {
      setPrinting(false);
    }
  };

  return (
    <div className="ticket-line overflow-hidden">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 border-b border-[var(--pos-border)] px-3 py-3 text-left sm:py-2.5"
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
          {!open ? (
            <div className="mt-1 text-sm font-semibold tabular-nums text-gray-50">
              {fmtCurrency.format(Number(ticket?.total || 0))}
              {items.length > 0 ? (
                <span className="ml-1.5 text-xs font-normal text-[color:var(--pos-fg-muted)]">
                  · {items.length}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="max-w-[42%] shrink-0 text-right text-xs leading-snug text-[color:var(--pos-fg-muted)] sm:max-w-none sm:whitespace-nowrap">
          {headerRight}
          <div className="mt-1 text-[11px] font-medium text-[color:var(--pos-accent)] sm:hidden">
            {open ? '▴' : '▾'}
          </div>
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
            {eurTotal != null ? (
              <div className="flex justify-between text-sm">
                <span className="text-[color:var(--pos-fg-muted)]">EUR</span>
                <span className="font-semibold tabular-nums">
                  {formatEur(eurTotal)}
                </span>
              </div>
            ) : null}
          </div>

          {reportTicketShowsFiscal(ticket) ? (
            <ReceiptFiscalBlock ticket={ticket} />
          ) : null}
        </div>
      )}

      {open ? (
        <div className="border-t border-[var(--pos-border)] p-2">
          <button
            type="button"
            className="pos-btn-primary flex w-full items-center justify-center gap-2 py-3 text-sm font-semibold"
            disabled={printing || !canPrint}
            onClick={(e) => {
              e.stopPropagation();
              void onPrint();
            }}
          >
            <IconPrinter className="size-4" />
            {printing ? t('reports.printingTicket') : t('order.printTicket')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ReceiptFiscalBlock({ ticket }: { ticket: any }) {
  const { t } = useTranslation();
  const pending = isFiscalPending(ticket);
  const registered = isFiscalRegistered(ticket);
  const nslf = String(ticket?.fiscalNslf || '').trim();
  const nivf = String(ticket?.fiscalNivf || '').trim();
  const eic = String(ticket?.fiscalEic || '').trim();
  const verifyUrl = reportTicketVerifyUrl(ticket);
  const hasCodes = Boolean(nslf || nivf || eic);

  return (
    <div className="mt-2 space-y-2 border-t border-[var(--pos-border)] pt-2 text-xs">
      {pending ? (
        <div className="space-y-1">
          <div className="text-center text-sm font-semibold text-amber-600">
            {t('reports.fiscalPendingTitle')}
          </div>
          <p className="text-center text-[11px] leading-snug text-[color:var(--pos-fg-muted)]">
            {t('reports.fiscalPendingBody')}
          </p>
          {ticket?.fiscalWarning ? (
            <p className="break-all text-[11px] text-[color:var(--pos-fg-muted)]">
              {String(ticket.fiscalWarning)}
            </p>
          ) : null}
        </div>
      ) : registered || hasCodes ? (
        <div className="text-center text-sm font-semibold tracking-wide">
          {t('reports.fiscalRegistered')}
        </div>
      ) : null}

      {hasCodes ? (
        <div className="space-y-1 break-all font-mono text-[11px] leading-snug text-[color:var(--pos-fg)]">
          {nivf ? (
            <div>
              {t('fiscal.salesNivf')}: {nivf}
            </div>
          ) : null}
          {nslf ? (
            <div>
              {t('fiscal.salesNslf')}: {nslf}
            </div>
          ) : null}
          {eic ? (
            <div>
              {t('fiscal.salesEic')}: {eic}
            </div>
          ) : null}
        </div>
      ) : null}

      {verifyUrl ? (
        <>
          <p className="break-all font-mono text-[10px] leading-snug text-[color:var(--pos-fg-muted)]">
            {verifyUrl}
          </p>
          <FiscalVerifyQr
            value={verifyUrl}
            caption={t('fiscal.salesVerifyQr')}
            openLabel={t('fiscal.salesOpenOfficial')}
          />
        </>
      ) : hasCodes || registered ? (
        <p className="text-[11px] leading-snug text-[color:var(--pos-fg-muted)]">
          {t('fiscal.salesVerifyNeedsNipt')}
        </p>
      ) : null}
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
        type="button"
        className="flex w-full items-start justify-between gap-3 border-b border-[var(--pos-border)] px-3 py-3 text-left sm:py-2.5"
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
          {!open ? (
            <div className="mt-1 text-sm font-semibold tabular-nums text-rose-300">
              {fmtCurrency.format(Number(ticket?.subtotal || 0))}
            </div>
          ) : null}
        </div>
        <div className="max-w-[42%] shrink-0 text-right text-xs leading-snug text-[color:var(--pos-fg-muted)] sm:max-w-none sm:whitespace-nowrap">
          {when ? when.toLocaleString() : ''}
          <div className="mt-1 text-[11px] font-medium text-[color:var(--pos-accent)] sm:hidden">
            {open ? '▴' : '▾'}
          </div>
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
