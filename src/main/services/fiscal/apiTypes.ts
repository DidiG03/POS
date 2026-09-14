/**
 * Request and response shapes for the easyPos Cloud Fiscalisation API
 * (`/fiscalisation-service/v1`).
 *
 * These mirror the published contract rather than what this POS happens to
 * send today. The distinction matters: the old draft type had exactly the
 * three fields the demo needed, so every rule the API enforces beyond them
 * — document types, electronic processes, buyer data, corrective
 * references — was invisible to the type checker and therefore unwritten.
 */

/**
 * Albanian VAT bands as the tax service names them.
 *
 * `A` and `C` are both zero-rated and are NOT interchangeable: `A` says the
 * seller is outside the VAT scheme, `C` says this particular supply is
 * exempt. `J` is the export rate. Deriving any of these from a numeric
 * percentage is impossible — 0% maps to three different codes — which is
 * why they come from configuration and not from arithmetic.
 */
export type VatCode =
  /** 0% — seller is not VAT registered. */
  | 'A'
  /** 20% — standard rate. */
  | 'B'
  /** 0% — exempt supply from a VAT-registered seller. */
  | 'C'
  /** 10% — reduced rate. */
  | 'D'
  /** 6% — reduced rate. */
  | 'E'
  /** 0% — export. */
  | 'J';

export const VAT_CODES: readonly VatCode[] = ['A', 'B', 'C', 'D', 'E', 'J'];

/** The nominal rate each band stands for, as a fraction. */
export const VAT_CODE_RATES: Readonly<Record<VatCode, number>> = {
  A: 0,
  B: 0.2,
  C: 0,
  D: 0.1,
  E: 0.06,
  J: 0,
};

/**
 * Document type. Omitted entirely for a plain sale, which the API reads as
 * NORMAL — so `undefined` and `'NORMAL'` mean the same thing on the wire.
 */
export type DocumentType =
  | 'NORMAL'
  | 'ORDER'
  | 'SUMMARY'
  | 'SELFISSUE'
  | 'EXPORT';

/**
 * Electronic invoicing process. The process is not cosmetic: it selects
 * which additional fields the tax service requires, so picking the wrong
 * one produces a validation failure rather than a differently-shaped
 * invoice.
 */
export type ElectronicProcess =
  | 'P1'
  | 'P2'
  | 'P3'
  /** Requires `prepaidAmount`. */
  | 'P4'
  | 'P5'
  | 'P6'
  | 'P7'
  | 'P8'
  /** Corrective — requires `correctiveInvoice.iicRef` to an invoice with an EIC. */
  | 'P9'
  /** Cancellation — requires `correctiveInvoice.iicRef` to an invoice with an EIC. */
  | 'P10'
  /** Partial / final invoicing. */
  | 'P11';

export const ELECTRONIC_PROCESSES: readonly ElectronicProcess[] = [
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
  'P6',
  'P7',
  'P8',
  'P9',
  'P10',
  'P11',
];

/** Processes whose extra required fields we enforce before sending. */
export const PROCESS_REQUIRING_PREPAID: readonly ElectronicProcess[] = ['P4'];
export const PROCESS_REQUIRING_IIC_REF: readonly ElectronicProcess[] = [
  'P9',
  'P10',
];

export type PaymentType =
  | 'CASH'
  | 'CARD'
  | 'CHECK'
  /** Bank transfer to an account — requires `details[]`. */
  | 'ACCOUNT'
  /** Used by ORDER documents, which carry no payment of their own. */
  | 'ORDER'
  | 'COMPANY'
  | 'SVOUCHER'
  | 'VOUCHER'
  | 'FACTORING'
  | 'KIND'
  | 'TRANSFER'
  | 'WAIVER'
  | 'OTHER';

/**
 * Bank account behind an `ACCOUNT` payment. All seven fields are required
 * by the API; a partially filled entry is rejected, not defaulted.
 */
export interface PaymentAccountDetail {
  idNumber: string;
  name: string;
  bankName: string;
  swift_code: string;
  country: string;
  countryCode: string;
  currency: string;
}

export const PAYMENT_ACCOUNT_DETAIL_FIELDS: readonly (keyof PaymentAccountDetail)[] =
  [
    'idNumber',
    'name',
    'bankName',
    'swift_code',
    'country',
    'countryCode',
    'currency',
  ];

export interface InvoicePayment {
  type: PaymentType;
  amount: number;
  details?: PaymentAccountDetail[];
}

/**
 * Line-level or invoice-level rebate. `inPercentage` and `inValue` are
 * mutually exclusive — sending both is a validation error.
 */
export interface Rebate {
  inPercentage?: number;
  inValue?: number;
}

export interface InvoiceArticle {
  articleId: string;
  vatCode: VatCode;
  name: string;
  soldIn: string;
  price: number;
  units: number;
  rebate?: Rebate;
}

/** Buyer identifier scheme. NUIS is the Albanian business tax number. */
export type BuyerIdType = 'NUIS' | 'ID' | 'PASS' | 'VAT' | 'TAX' | 'SOC';

/** Albanian NUIS: letter, eight digits, letter (e.g. `L41323029B`). */
export const NUIS_PATTERN = /^[A-Za-z][0-9]{8}[A-Za-z]$/;

/** Operator code issued by the tax service, e.g. `gh537ez280`. */
export const OPERATOR_CODE_PATTERN = /^[a-z]{2}\d{3}[a-z]{2}\d{3}$/;

/** The API accepts a docId between 5 and 200 characters. */
export const DOC_ID_MIN_LENGTH = 5;
export const DOC_ID_MAX_LENGTH = 200;

/** Default currency for Albanian fiscalisation. */
export const DEFAULT_CURRENCY = 'ALL';

export interface InvoiceBuyer {
  buyerIDType: BuyerIdType;
  buyerID: string;
  name: string;
  address?: string;
  city?: string;
  country?: string;
  countryCode?: string;
}

export interface InvoiceCurrency {
  code: string;
  /** Rate against ALL. Required whenever `code` is not ALL. */
  exRate?: number;
}

/** Reference to the invoice a corrective or cancellation document undoes. */
export interface CorrectiveInvoiceRef {
  iicRef: string;
  /**
   * Not sent on cancellations — easyPos returns HTTP 400
   * "Unknown fields found" for `type` and `issueDateTimeRef`.
   */
  issueDateTimeRef?: string;
  type?: 'CORRECTIVE' | 'CANCELLATION';
}

/** Period covered by an EXPORT supply. */
export interface SupplyPeriod {
  start: string;
  end: string;
}

/** One ORDER invoice rolled up by a SUMMARY document, referenced by IIC. */
export interface SummaryInvoiceRef {
  iic: string;
}

export interface RegisterInvoiceRequest {
  /** Stable per business document. Generated once, reused on every retry. */
  docId: string;
  /** Omitted for a plain sale. */
  documentType?: DocumentType;
  articles?: InvoiceArticle[];
  payment?: InvoicePayment[];
  operatorCode?: string;
  currency?: InvoiceCurrency;
  buyer?: InvoiceBuyer;
  invoiceRebate?: Rebate;
  /** SUMMARY only: the ORDER invoices being settled. */
  summaryInvoices?: SummaryInvoiceRef[];
  /** SUMMARY only: must equal the referenced ORDER total exactly. */
  total?: number;
  /** SELFISSUE only. */
  selfIssueType?: string;
  /** SELFISSUE only. */
  reverseCharge?: boolean;
  /** EXPORT only. */
  supplyPeriod?: SupplyPeriod;
  isEinvoice?: boolean;
  /** Electronic invoices only. */
  selectedProcess?: ElectronicProcess;
  /** P4 only. Must be > 0 and <= total. */
  prepaidAmount?: number;
  /** P9 / P10 and every cancellation. */
  correctiveInvoice?: CorrectiveInvoiceRef;
  [extra: string]: unknown;
}

export interface CancelInvoiceRequest {
  /** A NEW docId — never the cancelled invoice's own docId. */
  docId: string;
  correctiveInvoice: CorrectiveInvoiceRef;
  operatorCode?: string;
  isEinvoice?: boolean;
  /** `P10` when cancelling an electronic invoice. */
  selectedProcess?: ElectronicProcess;
  [extra: string]: unknown;
}

export interface InvoiceStatusRequest {
  /** The docId of the document whose fate we are asking about. */
  docId: string;
}

export type PdfType = 'A4' | 'receipt' | 'eInvoice';
export type PdfPaperWidth = 58 | 80 | 110;
export type PdfLang = 'sq' | 'en';

export const PDF_TYPES: readonly PdfType[] = ['A4', 'receipt', 'eInvoice'];
export const PDF_PAPER_WIDTHS: readonly PdfPaperWidth[] = [58, 80, 110];
export const PDF_LANGS: readonly PdfLang[] = ['sq', 'en'];

export interface InvoicePdfRequest {
  docId: string;
  pdfType: PdfType;
  /** `receipt` only. */
  paperWidth?: PdfPaperWidth;
  lang?: PdfLang;
}

/** Cash balance operations. Amounts are always in ALL. */
export interface BalanceRequest {
  docId: string;
  amount: number;
  operatorCode?: string;
  [extra: string]: unknown;
}

export interface GetTaxpayersRequest {
  searchTerm: string;
}

export const TAXPAYER_SEARCH_MIN_LENGTH = 3;
export const TAXPAYER_SEARCH_MAX_LENGTH = 200;

export interface GetOperatorsRequest {
  [extra: string]: unknown;
}

/**
 * A fault raised by the tax service (CIS) and passed through by easyPos.
 *
 * `faultEnv` is the field that decides retryability, and it is the one the
 * previous implementation never read: `env:CLIENT` means our data is wrong
 * and will be wrong again next time, `env:SERVER` means the tax service
 * itself failed and the same request may well succeed.
 */
export interface CisError {
  faultCode?: string;
  faultString?: string;
  faultEnv?: string;
  [extra: string]: unknown;
}

export interface ApiErrorEnvelope {
  cisError?: CisError;
  otherError?: { message?: string; code?: string; [extra: string]: unknown };
  [extra: string]: unknown;
}

/**
 * Response body common to the invoice routes. Every identifier is optional
 * because the API returns HTTP 200 with an empty or partial body when the
 * document did not complete — which is exactly why HTTP status alone can
 * never be read as success.
 */
export interface FiscalApiResponse {
  /** NSLF — allocated locally by the fiscal device. Not a registration. */
  iic?: string;
  /** NIVF — issued by the tax service. Presence means the invoice is filed. */
  fic?: string;
  /** Electronic invoice identifier. Required alongside `fic` for eInvoices. */
  eic?: string;
  /** Fiscal cash deposit code — the completion marker for balance ops. */
  fcdc?: string;
  /** PDF payload. */
  base64?: string;
  iicSignature?: string;
  qrCode?: string;
  link?: string;
  docId?: string;
  status?: number | string;
  message?: string;
  error?: ApiErrorEnvelope;
  response?: Record<string, unknown>;
  [extra: string]: unknown;
}

export interface TaxpayerRecord {
  nuis?: string;
  name?: string;
  address?: string;
  city?: string;
  [extra: string]: unknown;
}

export interface OperatorRecord {
  operatorCode?: string;
  name?: string;
  [extra: string]: unknown;
}
