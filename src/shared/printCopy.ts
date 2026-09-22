export type PrintLang = 'en' | 'sq';

export function printLangFromSettings(
  settings?: {
    preferences?: { language?: string | null };
  } | null,
): PrintLang {
  return String(settings?.preferences?.language || '')
    .trim()
    .toLowerCase() === 'sq'
    ? 'sq'
    : 'en';
}

type PrintCopy = {
  restaurantFallback: string;
  sale: string;
  waiter: string;
  cashier: string;
  covers: string;
  subtotal: string;
  vat: string;
  service: string;
  servicePct: (pct: number) => string;
  discount: string;
  discountPct: (pct: number) => string;
  total: string;
  totalLek: string;
  totalEur: string;
  currency: string;
  paid: string;
  method: string;
  approved: string;
  note: string;
  thankYou: string;
  poweredBy: string;
  fiscalPendingTitle: string;
  fiscalPendingBody: string;
  fiscalRegistered: string;
  shiftReport: string;
  opened: string;
  closed: string;
  orders: string;
  netSales: string;
  byPayment: string;
  endOfShift: string;
};

const EN: PrintCopy = {
  restaurantFallback: 'Restaurant',
  sale: 'Sale',
  waiter: 'Waiter',
  cashier: 'Cashier',
  covers: 'Covers',
  subtotal: 'Subtotal',
  vat: 'VAT',
  service: 'Service charge',
  servicePct: (pct) => `Service (${pct}%)`,
  discount: 'Discount',
  discountPct: (pct) => `Discount (${pct}%)`,
  total: 'TOTAL',
  totalLek: 'LEK',
  totalEur: 'EUR',
  currency: 'Currency',
  paid: 'PAID',
  method: 'Method',
  approved: 'Approved',
  note: 'Note',
  thankYou: 'Thank you!',
  poweredBy: 'Powered by OneTap POS',
  fiscalPendingTitle: 'FISKALIZIMI NE PRITJE',
  fiscalPendingBody:
    'Invoice will be sent to the tax service when the connection is back.',
  fiscalRegistered: 'FISKALIZUAR',
  shiftReport: 'SHIFT REPORT',
  opened: 'Opened',
  closed: 'Closed',
  orders: 'Orders',
  netSales: 'Net sales',
  byPayment: 'By payment:',
  endOfShift: 'End of shift',
};

const SQ: PrintCopy = {
  restaurantFallback: 'Restorant',
  sale: 'Shitje',
  waiter: 'Kamarier',
  cashier: 'Kasier',
  covers: 'Të ftuar',
  subtotal: 'Nëntotali',
  vat: 'TVSH',
  service: 'Shërbimi',
  servicePct: (pct) => `Shërbimi (${pct}%)`,
  discount: 'Zbritje',
  discountPct: (pct) => `Zbritje (${pct}%)`,
  total: 'TOTALI',
  totalLek: 'LEK',
  totalEur: 'EUR',
  currency: 'Valuta',
  paid: 'E PAGUAR',
  method: 'Metoda',
  approved: 'Aprovuar',
  note: 'Shënim',
  thankYou: 'Faleminderit!',
  poweredBy: 'Mundësuar nga OneTap POS',
  fiscalPendingTitle: 'FISKALIZIMI NË PRITJE',
  fiscalPendingBody: 'Fatura do të dërgohet te tatimet kur të kthehet lidhja.',
  fiscalRegistered: 'FISKALIZUAR',
  shiftReport: 'RAPORTI I TURNIT',
  opened: 'Hapur',
  closed: 'Mbyllur',
  orders: 'Porosi',
  netSales: 'Shitje neto',
  byPayment: 'Sipas pagesës:',
  endOfShift: 'Fundi i turnit',
};

const METHOD: Record<PrintLang, Record<string, string>> = {
  en: {
    CASH: 'CASH',
    CARD: 'CARD',
    CHECK: 'CHECK',
    MIXED: 'MIXED',
    OTHER: 'OTHER',
  },
  sq: {
    CASH: 'PARA',
    CARD: 'KARTË',
    CHECK: 'ÇEK',
    MIXED: 'E PËRZIER',
    OTHER: 'TJETËR',
  },
};

export function printCopy(lang: PrintLang): PrintCopy {
  return lang === 'sq' ? SQ : EN;
}

export function printCopyFromSettings(
  settings?: {
    preferences?: { language?: string | null };
  } | null,
): PrintCopy {
  return printCopy(printLangFromSettings(settings));
}

export function printStaffLabel(lang: PrintLang, diningFloor: boolean): string {
  const copy = printCopy(lang);
  return diningFloor ? copy.waiter : copy.cashier;
}

export function printPaymentMethod(lang: PrintLang, raw: string): string {
  const key = String(raw || '')
    .trim()
    .toUpperCase();
  if (!key) return '';
  return METHOD[lang][key] || key;
}
