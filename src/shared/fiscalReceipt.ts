/**
 * What to print on a till receipt for a fiscalized sale.
 *
 * The thermal printer cannot render easyPos' PDF. The tax-service QR is the
 * verification the guest needs: the official check URL when easyPos gave us
 * one, otherwise the CIS invoice-check page keyed by IIC (NSLF).
 *
 * Cloud-only venues get no IIC until register succeeds, so a deferred sale
 * must not print FISKALIZUAR or a QR — that would claim an invoice CIS
 * does not have yet.
 *
 * CIS InvoiceCheck refuses a URL that only has `iic` and sends the browser
 * to `#/noData` ("Disa informacione mungojnë"). The official QR is
 * `iic` + `tin` (NIPT) + `crtd` (issue time) + `prc` (total).
 */

export const CIS_INVOICE_VERIFY_URL =
  'https://efiskalizimi-app.tatime.gov.al/invoice-check/#/verify';

/** Long enough for a URL + IIC; longer payloads are likely a base64 image. */
const MAX_QR_PAYLOAD = 512;

function text(value: unknown): string {
  return String(value || '').trim();
}

export function isFiscalPending(
  meta:
    | {
        fiscalStatus?: string;
        fiscalNivf?: string;
        fiscalWarning?: string;
      }
    | null
    | undefined,
): boolean {
  if (!meta) return false;
  if (String(meta.fiscalStatus || '').toLowerCase() === 'pending') return true;
  return Boolean(text(meta.fiscalWarning)) && !text(meta.fiscalNivf);
}

export function isFiscalRegistered(
  meta:
    | {
        fiscalNivf?: string;
        fiscalNslf?: string;
        fiscalLink?: string;
      }
    | null
    | undefined,
): boolean {
  return Boolean(text(meta?.fiscalNivf));
}

export function fiscalTinFromSettings(settings: unknown): string {
  return text((settings as any)?.fiscal?.nipt);
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function looksLikeQrImageDump(value: string): boolean {
  return /^(data:|iVBOR|AAAA|JVBERi)/i.test(value);
}

function isCisInvoiceCheck(url: string): boolean {
  return /tatime\.gov\.al\/invoice-check/i.test(url);
}

function hashQuery(url: string): URLSearchParams {
  const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : '';
  const qIndex = hash.indexOf('?');
  return new URLSearchParams(qIndex >= 0 ? hash.slice(qIndex + 1) : '');
}

function completeCisParams(params: {
  iic?: string;
  tin?: string;
  crtd?: string;
  prc?: string;
}): params is { iic: string; tin: string; crtd: string; prc: string } {
  return Boolean(params.iic && params.tin && params.crtd && params.prc);
}

function buildCisUrl(params: {
  iic: string;
  tin: string;
  crtd: string;
  prc: string;
}): string {
  return (
    `${CIS_INVOICE_VERIFY_URL}` +
    `?iic=${encodeURIComponent(params.iic)}` +
    `&tin=${encodeURIComponent(params.tin)}` +
    `&crtd=${encodeURIComponent(params.crtd)}` +
    `&prc=${encodeURIComponent(params.prc)}`
  );
}

/** Local ISO-8601 with offset, no milliseconds — the form CIS parses. */
export function formatCisIssueDate(
  raw: string | Date | null | undefined,
): string {
  if (raw == null || raw === '') return '';
  const d = raw instanceof Date ? raw : new Date(raw);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n: number) => String(Math.abs(Math.trunc(n))).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`
  );
}

export function formatCisPrice(total: number | null | undefined): string {
  const n = Number(total);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(2);
}

export function tinFromVerifyUrl(url: string | null | undefined): string {
  const raw = text(url);
  if (!raw) return '';
  return text(hashQuery(raw).get('tin'));
}

function pickProviderUrl(value: string): string | undefined {
  if (!value || value.length > MAX_QR_PAYLOAD) return undefined;
  if (looksLikeQrImageDump(value)) return undefined;
  if (looksLikeUrl(value)) {
    if (!isCisInvoiceCheck(value)) return value;
    const q = hashQuery(value);
    if (
      completeCisParams({
        iic: text(q.get('iic')),
        tin: text(q.get('tin')),
        crtd: text(q.get('crtd')),
        prc: text(q.get('prc')),
      })
    ) {
      return value;
    }
    return undefined;
  }
  if (
    value.length > 8 &&
    (value.includes('iic=') || value.includes('invoice-check'))
  ) {
    return value;
  }
  return undefined;
}

/**
 * Bytes that go into the ESC/POS QR. Prefer a complete provider verification
 * link; otherwise build the official CIS URL. Never return an `iic`-only
 * invoice-check link — CIS treats that as missing data.
 */
export function fiscalVerificationQr(input: {
  link?: string;
  qrCode?: string;
  nslf?: string;
  tin?: string;
  issuedAt?: string | Date | null;
  total?: number | null;
}): string | undefined {
  const fromLink = pickProviderUrl(text(input.link));
  if (fromLink) return fromLink;

  const qr = text(input.qrCode);
  const fromQr = pickProviderUrl(qr);
  if (fromQr) return fromQr;

  const q = hashQuery(text(input.link) || qr);
  const iic = text(input.nslf) || text(q.get('iic'));
  const tin = text(input.tin) || text(q.get('tin'));
  const crtd = formatCisIssueDate(input.issuedAt) || text(q.get('crtd'));
  const prc = formatCisPrice(input.total) || text(q.get('prc'));
  if (!completeCisParams({ iic, tin, crtd, prc })) return undefined;
  const built = buildCisUrl({ iic, tin, crtd, prc });
  return built.length <= MAX_QR_PAYLOAD ? built : undefined;
}

/**
 * CIS check URL for a voided fiscalized sale.
 *
 * A void is a separate cancellation invoice on CIS. The original IIC still
 * opens the first cash invoice ("Fiskalizimi i suksesshëm") — InvoiceCheck
 * only shows the void when we open the cancellation document's IIC.
 */
export function fiscalVoidVerifyUrl(
  sale:
    | {
        status?: string | null;
        fiscalNslf?: string | null;
        fiscalLink?: string | null;
        fiscalQrCode?: string | null;
        fiscalTin?: string | null;
        closedAt?: string | Date | null;
        total?: number | null;
        corrections?: Array<{
          kind?: string;
          correctionNslf?: string | null;
          filedAt?: string | Date | null;
          amountDelta?: number | null;
        }>;
      }
    | null
    | undefined,
): string | undefined {
  const status = String(sale?.status || '').toUpperCase();
  if (status !== 'VOID' && status !== 'VOIDED') return undefined;
  const cancel = (sale?.corrections || []).find(
    (c) =>
      String(c.kind || '').toUpperCase() === 'CANCEL' && text(c.correctionNslf),
  );
  if (cancel) {
    const cancelledTotal = Math.abs(Number(cancel.amountDelta || 0));
    return fiscalVerificationQr({
      nslf: text(cancel.correctionNslf) || undefined,
      tin: text(sale?.fiscalTin) || undefined,
      issuedAt: cancel.filedAt || sale?.closedAt,
      total: cancelledTotal > 0 ? cancelledTotal : sale?.total,
    });
  }
  return fiscalVerificationQr({
    link: text(sale?.fiscalLink) || undefined,
    qrCode: text(sale?.fiscalQrCode) || undefined,
    nslf: text(sale?.fiscalNslf) || undefined,
    tin: text(sale?.fiscalTin) || undefined,
    issuedAt: sale?.closedAt,
    total: sale?.total,
  });
}

/** Original invoice as first filed — CIS will not say this one is voided. */
export function fiscalOriginalVerifyUrl(
  sale:
    | {
        fiscalNslf?: string | null;
        fiscalLink?: string | null;
        fiscalQrCode?: string | null;
        fiscalTin?: string | null;
        closedAt?: string | Date | null;
        total?: number | null;
      }
    | null
    | undefined,
): string | undefined {
  return fiscalVerificationQr({
    link: text(sale?.fiscalLink) || undefined,
    qrCode: text(sale?.fiscalQrCode) || undefined,
    nslf: text(sale?.fiscalNslf) || undefined,
    tin: text(sale?.fiscalTin) || undefined,
    issuedAt: sale?.closedAt,
    total: sale?.total,
  });
}
