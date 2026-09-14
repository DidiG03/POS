/**
 * Turn stored notification text into a grouped, scannable card.
 *
 * Rows are plain English sentences written by the host over years of
 * features. The dropdown cannot wait for a schema migration, so this
 * classifies the strings already in the database and leaves unknown
 * copy as a fallback card.
 */

export const NOTIFICATION_KINDS = [
  'fiscal',
  'security',
  'ticket',
  'shift',
  'request',
  'other',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type NotificationTone = 'danger' | 'warn' | 'neutral';

export type ParsedNotification = {
  kind: NotificationKind;
  titleKey: string;
  summaryKey?: string;
  titleParams?: Record<string, string>;
  summaryParams?: Record<string, string>;
  where?: string;
  area?: string;
  tableLabel?: string;
  docId?: string;
  nslf?: string;
  saleId?: string;
  detail?: string;
  tone: NotificationTone;
};

export type NotificationHref = {
  pathname: string;
  search: string;
};

function text(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(value: string, max = 280): string | undefined {
  const s = text(value);
  if (s.length < 12) return undefined;
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/** "Salla Table T7" / "Bar Table 4" → area, table, and a short label. */
export function notificationPlace(message: string): {
  area?: string;
  tableLabel?: string;
  where?: string;
} {
  const named = message.match(
    /\b(?:for|on)\s+([^:·]+?)\s+Table\s+([^\s:·,]+)/i,
  );
  if (named) {
    const area = text(named[1]);
    const tableLabel = text(named[2]);
    return { area, tableLabel, where: `${area} ${tableLabel}` };
  }
  const table = message.match(/\bTable\s+([^\s:·,]+)/i);
  if (table) return { tableLabel: table[1], where: table[1] };
  return {};
}

/** "Salla Table T7" / "Bar Table 4" → "Salla T7". */
export function notificationWhere(message: string): string | undefined {
  return notificationPlace(message).where;
}

function notificationIds(message: string): {
  docId?: string;
  nslf?: string;
  saleId?: string;
} {
  return {
    docId: message.match(/\bdocId\s+([0-9a-f-]{8,})/i)?.[1],
    nslf: message.match(/\bNSLF[:\s]+([A-Z0-9]+)/i)?.[1],
    saleId: message.match(/\bSale #(\d+)/i)?.[1],
  };
}

function withPlace(
  parsed: ParsedNotification,
  message: string,
): ParsedNotification {
  return {
    ...parsed,
    ...notificationPlace(message),
    ...notificationIds(message),
  };
}

function dayQuery(createdAt?: string): { start: string; end: string } | null {
  const t = Date.parse(String(createdAt || ''));
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const end = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    23,
    59,
    59,
    999,
  );
  return { start: start.toISOString(), end: end.toISOString() };
}

function qs(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const out = search.toString();
  return out ? `?${out}` : '';
}

/**
 * Where tapping a notification should take an admin (or a waiter).
 *
 * Fiscal problems open the review queue on Fiskalizimi. Ticket events open
 * that table's tickets for the day of the alert. PIN / staff issues open
 * the admin home where accounts are managed.
 */
export function notificationHref(
  parsed: ParsedNotification,
  opts?: { createdAt?: string; admin?: boolean },
): NotificationHref | null {
  const admin = opts?.admin !== false;
  const day = dayQuery(opts?.createdAt);

  if (!admin) {
    if (parsed.tableLabel || parsed.kind === 'request') {
      return {
        pathname: '/app/tables',
        search: qs({
          area: parsed.area,
          table: parsed.tableLabel,
        }),
      };
    }
    return null;
  }

  if (parsed.kind === 'fiscal') {
    return {
      pathname: '/admin/settings',
      search: qs({
        section: 'fiscal',
        doc: parsed.docId,
        table: parsed.tableLabel,
        area: parsed.area,
        nslf: parsed.nslf,
      }),
    };
  }

  if (parsed.kind === 'ticket' && (parsed.tableLabel || parsed.saleId)) {
    const voided =
      parsed.titleKey === 'inbox.voidTicketTitle' ||
      parsed.titleKey === 'inbox.saleReversedTitle';
    return {
      pathname: '/admin/tickets',
      search: qs({
        area: parsed.area,
        table: parsed.tableLabel,
        start: day?.start,
        end: day?.end,
        open: '1',
        status: voided ? 'VOIDED' : undefined,
        sale: parsed.saleId,
      }),
    };
  }

  if (parsed.kind === 'ticket' || parsed.kind === 'shift') {
    return {
      pathname: '/admin/tickets',
      search: qs({ start: day?.start, end: day?.end }),
    };
  }

  if (parsed.titleKey === 'inbox.unusualTitle') {
    return {
      pathname: '/admin/tickets',
      search: qs({ start: day?.start, end: day?.end }),
    };
  }

  if (parsed.kind === 'security') {
    return { pathname: '/admin', search: qs({ focus: 'staff' }) };
  }

  return null;
}

function afterLabel(message: string, label: RegExp): string | undefined {
  const match = message.match(label);
  if (!match || match.index == null) return undefined;
  return clip(message.slice(match.index + match[0].length));
}

export function parseNotification(
  message: string,
  storedType?: string | null,
): ParsedNotification {
  const raw = String(message || '').trim();
  const security = String(storedType || '').toUpperCase() === 'SECURITY';
  const finish = (parsed: ParsedNotification) => withPlace(parsed, raw);

  if (/wrong pin attempt/i.test(raw)) {
    return finish({
      kind: 'security',
      titleKey: 'inbox.pinTitle',
      summaryKey: 'inbox.pinSummary',
      tone: 'danger',
    });
  }

  if (/unusual activity \(auto-check\)/i.test(raw)) {
    return finish({
      kind: 'security',
      titleKey: 'inbox.unusualTitle',
      summaryKey: 'inbox.unusualSummary',
      detail: clip(raw),
      tone: 'warn',
    });
  }

  if (/fiskalizimi is unreachable/i.test(raw)) {
    return finish({
      kind: 'fiscal',
      titleKey: 'inbox.fiscalUnreachableTitle',
      summaryKey: 'inbox.fiscalUnreachableSummary',
      detail:
        afterLabel(raw, /48-hour window\)\.\s*/i) ||
        afterLabel(raw, /48 hours\)\.\s*/i),
      tone: 'warn',
    });
  }

  if (/48-hour window missed/i.test(raw)) {
    return finish({
      kind: 'fiscal',
      titleKey: 'inbox.fiscalOverdueTitle',
      summaryKey: 'inbox.fiscalOverdueSummary',
      detail: clip(raw),
      tone: 'danger',
    });
  }

  if (/fiskalizimi still pending/i.test(raw)) {
    return finish({
      kind: 'fiscal',
      titleKey: 'inbox.fiscalPendingTitle',
      summaryKey: 'inbox.fiscalPendingSummary',
      detail: clip(raw),
      tone: 'warn',
    });
  }

  if (
    /cancellation was not filed|needs a cancellation|cancellation invoice required/i.test(
      raw,
    )
  ) {
    return finish({
      kind: 'fiscal',
      titleKey: 'inbox.fiscalCancelTitle',
      summaryKey: 'inbox.fiscalCancelSummary',
      detail:
        afterLabel(raw, /cancellation was not filed:\s*/i) ||
        afterLabel(raw, /:\s*/) ||
        clip(raw),
      tone: 'danger',
    });
  }

  if (
    /corrective fiscal invoice required|needs a corrective invoice|corrective invoice required/i.test(
      raw,
    )
  ) {
    return finish({
      kind: 'fiscal',
      titleKey: 'inbox.fiscalCorrectiveTitle',
      summaryKey: 'inbox.fiscalCorrectiveSummary',
      detail: afterLabel(raw, /:\s*/) || clip(raw),
      tone: 'danger',
    });
  }

  if (
    /fiskalizimi needs review|fiskalizimi failed|deferred fiskalizimi is now refused/i.test(
      raw,
    )
  ) {
    return finish({
      kind: 'fiscal',
      titleKey: 'inbox.fiscalReviewTitle',
      summaryKey: 'inbox.fiscalReviewSummary',
      detail: afterLabel(raw, /:\s*/) || clip(raw),
      tone: 'danger',
    });
  }

  const discount = raw.match(
    /^Discount applied \(([^)]+)\) on .+?: -([\d.]+) \(total ([\d.]+) → ([\d.]+)\)(.*)$/i,
  );
  if (discount) {
    const tail = discount[5] || '';
    const method = tail.match(/method\s+([^·]+)/i)?.[1]?.trim();
    const reason = tail.match(/reason:\s*([^·]+)/i)?.[1]?.trim();
    const approved = tail.match(/approved by:\s*([^·]+)/i)?.[1]?.trim();
    const extras = [method, reason, approved].filter(Boolean).join(' · ');
    return finish({
      kind: 'ticket',
      titleKey: 'inbox.discountTitle',
      summaryKey: 'inbox.discountSummary',
      summaryParams: {
        amount: discount[2],
        before: discount[3],
        after: discount[4],
        extras,
      },
      tone: 'neutral',
    });
  }

  if (/^voided item\b/i.test(raw)) {
    return finish({
      kind: 'ticket',
      titleKey: 'inbox.voidItemTitle',
      detail: clip(raw.replace(/^voided item on [^:]+:\s*/i, '')),
      tone: 'warn',
    });
  }

  if (/^voided ticket\b/i.test(raw)) {
    return finish({
      kind: 'ticket',
      titleKey: 'inbox.voidTicketTitle',
      detail: clip(raw),
      tone: 'warn',
    });
  }

  if (/^sale #\d+ reversed/i.test(raw)) {
    return finish({
      kind: 'ticket',
      titleKey: 'inbox.saleReversedTitle',
      detail: clip(raw),
      tone: 'warn',
    });
  }

  if (/your request #\d+.+\bapproved\b/i.test(raw)) {
    return finish({
      kind: 'request',
      titleKey: 'inbox.requestApprovedTitle',
      detail: clip(raw),
      tone: 'neutral',
    });
  }

  if (/your request #\d+.+\brejected\b/i.test(raw)) {
    return finish({
      kind: 'request',
      titleKey: 'inbox.requestRejectedTitle',
      detail: clip(raw),
      tone: 'warn',
    });
  }

  if (/shift auto-closed|auto-closed shift/i.test(raw)) {
    return finish({
      kind: 'shift',
      titleKey: 'inbox.shiftClosedTitle',
      detail: clip(raw),
      tone: 'neutral',
    });
  }

  if (
    /receipt audit row could not be saved|receipt record could not be saved/i.test(
      raw,
    )
  ) {
    return finish({
      kind: 'ticket',
      titleKey: 'inbox.receiptAuditTitle',
      detail: clip(raw),
      tone: 'danger',
    });
  }

  const firstLine = raw.split(/[.\n]/)[0]?.trim() || raw;
  return finish({
    kind: security ? 'security' : 'other',
    titleKey: 'inbox.fallbackTitle',
    titleParams: { text: firstLine.slice(0, 80) },
    detail: clip(raw),
    tone: security ? 'warn' : 'neutral',
  });
}

export function groupNotifications<
  T extends { message: string; type?: string },
>(items: T[]): Array<{ kind: NotificationKind; items: T[] }> {
  const buckets = new Map<NotificationKind, T[]>();
  for (const item of items) {
    const kind = parseNotification(item.message, item.type).kind;
    const list = buckets.get(kind) || [];
    list.push(item);
    buckets.set(kind, list);
  }
  return NOTIFICATION_KINDS.filter((kind) => buckets.has(kind)).map((kind) => ({
    kind,
    items: buckets.get(kind)!,
  }));
}

export function formatNotificationTime(
  iso: string,
  tr: (key: string, opt?: Record<string, unknown>) => string,
  now = Date.now(),
): string {
  const createdAt = new Date(iso).getTime();
  const diffMs = Math.max(
    0,
    now - (Number.isFinite(createdAt) ? createdAt : now),
  );
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;
  if (diffMs < hourMs) {
    return tr('time.minutesAgo', {
      count: Math.max(1, Math.floor(diffMs / minuteMs)),
    });
  }
  if (diffMs < dayMs) {
    return tr('time.hoursAgo', {
      count: Math.max(1, Math.floor(diffMs / hourMs)),
    });
  }
  if (diffMs < weekMs) {
    return tr('time.daysAgo', {
      count: Math.max(1, Math.floor(diffMs / dayMs)),
    });
  }
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yy} ${hh}:${min}`;
}
