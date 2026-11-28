/**
 * Status lights in the till header and in Admin: Fiscal, Printers, Backup,
 * Devices, Database. Each is green, amber or red with a plain message and
 * what to do. Built from facts the till gathers (`statusLightsRead.ts`);
 * this file only decides, so it can be tested.
 */

export type LightLevel = 'green' | 'amber' | 'red' | 'off';
export type LightKey =
  | 'fiscal'
  | 'printers'
  | 'backup'
  | 'devices'
  | 'database';

export interface StatusLight {
  key: LightKey;
  level: LightLevel;
  /** One line, plain language. */
  message: string;
  /** Lines with detail (per printer, per review). */
  details: string[];
  /** What to do about it, when not green. */
  fix?: string;
}

export interface PrinterFact {
  name: string;
  /** Which stations it prints for (Kitchen, Bar, Receipts…). */
  roles: string[];
  /** The network check: answered, did not, or not checked (USB/system). */
  reachable: boolean | null;
  /** Slips waiting to be printed again on it. */
  retrying: number;
  /** Slips that gave up in the last hour. */
  failedRecently: number;
  /** Last slip: ok or failed, and when. */
  lastResult?: { ok: boolean; at: string } | null;
}

export interface StatusFacts {
  now: number;
  fiscal: {
    enabled: boolean;
    /** easyPos answered the last network check. */
    reachable: boolean | null;
    /** The till stopped waiting for easyPos after repeated timeouts. */
    breakerOpen: boolean;
    /** Sales on the review list (refused, unconfirmed, corrections). */
    reviews: number;
    /** Invoices queued to send by themselves (outage). */
    queued: number;
    /** Oldest queued invoice, ISO, for the 48-hour rule. */
    oldestQueuedAt?: string | null;
  };
  printers: PrinterFact[];
  backup: {
    auto: boolean;
    lastOkAt: string | null;
    lastFailed: boolean;
    lastError?: string | null;
    /** Manual "Save Backup To…" copy off this computer. */
    savedElsewhereAt: string | null;
  };
  devices: {
    online: number;
    /** Devices seen today on an app older than the till. */
    older: Array<{ version: string; devices: number }>;
    tillVersion: string;
  };
  database: {
    /** Last time a request failed because the ledger was busy or stalled. */
    lastBusyAt: string | null;
    freeBytes: number | null;
  };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (now: number, iso: string | null | undefined) => {
  const t = Date.parse(String(iso || ''));
  return Number.isFinite(t) ? now - t : null;
};
const hours = (ms: number) => Math.floor(ms / HOUR);

export function fiscalLight(f: StatusFacts): StatusLight {
  const x = f.fiscal;
  if (!x.enabled) {
    return {
      key: 'fiscal',
      level: 'off',
      message: 'Fiskalizimi is off.',
      details: [],
    };
  }
  const details: string[] = [];
  if (x.reviews)
    details.push(`${x.reviews} sale(s) need a person to look at them.`);
  if (x.queued) details.push(`${x.queued} invoice(s) waiting to be sent.`);
  if (x.reachable === false || x.breakerOpen) {
    return {
      key: 'fiscal',
      level: 'red',
      message:
        "easyPos can't be reached: sales are taken and their invoices queued.",
      details,
      fix: 'Check the internet connection of the till. Queued invoices are sent by themselves within 48 hours.',
    };
  }
  const oldest = ago(f.now, x.oldestQueuedAt);
  if (oldest != null && oldest > 36 * HOUR) {
    return {
      key: 'fiscal',
      level: 'red',
      message: `An invoice has waited ${hours(oldest)} hours: the legal limit is 48.`,
      details,
      fix: 'Open Settings › Fiskalizimi › Reviews and send it now.',
    };
  }
  if (x.reviews > 0) {
    return {
      key: 'fiscal',
      level: 'amber',
      message: `${x.reviews} sale(s) have no tax invoice yet and need you.`,
      details,
      fix: 'Open the review list and fix each sale.',
    };
  }
  if (x.queued > 0) {
    return {
      key: 'fiscal',
      level: 'amber',
      message: `${x.queued} invoice(s) waiting to be sent.`,
      details,
      fix: 'Nothing to do: they are sent by themselves.',
    };
  }
  return {
    key: 'fiscal',
    level: 'green',
    message: 'Connected. Every sale is filed.',
    details,
  };
}

export function printersLight(f: StatusFacts): StatusLight {
  if (!f.printers.length) {
    return {
      key: 'printers',
      level: 'amber',
      message: 'No printer is set up.',
      details: [],
      fix: 'Add a printer in Settings › Printers.',
    };
  }
  let level: LightLevel = 'green';
  const details: string[] = [];
  const bad: string[] = [];
  for (const p of f.printers) {
    const who = `${p.name}${p.roles.length ? ` (${p.roles.join(', ')})` : ''}`;
    if (p.reachable === false || p.failedRecently > 0) {
      level = 'red';
      bad.push(p.name);
      details.push(
        `${who}: ${p.reachable === false ? 'not answering' : `${p.failedRecently} slip(s) failed`}${p.retrying ? `, ${p.retrying} waiting` : ''}.`,
      );
    } else if (p.retrying > 0) {
      if (level === 'green') level = 'amber';
      bad.push(p.name);
      details.push(`${who}: ${p.retrying} slip(s) waiting to print again.`);
    } else {
      details.push(
        `${who}: ok${p.lastResult ? `, last slip ${p.lastResult.ok ? 'printed' : 'failed'}` : ''}.`,
      );
    }
  }
  return {
    key: 'printers',
    level,
    message:
      level === 'green'
        ? 'All printers ready.'
        : `${bad.join(', ')}: ${level === 'red' ? 'not printing' : 'slips waiting'}.`,
    details,
    ...(level !== 'green'
      ? {
          fix: 'Check the printer is on, has paper and is on the network. Waiting slips print by themselves when it is back.',
        }
      : {}),
  };
}

export function backupLight(f: StatusFacts): StatusLight {
  const b = f.backup;
  if (b.auto) {
    if (b.lastFailed) {
      return {
        key: 'backup',
        level: 'red',
        message: `The last automatic backup failed${b.lastError ? `: ${b.lastError}` : '.'}`,
        details: [],
        fix: 'Check the backup folder (USB stick or network folder) in Settings › Backups.',
      };
    }
    const age = ago(f.now, b.lastOkAt);
    if (age == null) {
      return {
        key: 'backup',
        level: 'amber',
        message: 'No automatic backup yet: the first runs within minutes.',
        details: [],
      };
    }
    if (age > DAY) {
      return {
        key: 'backup',
        level: 'amber',
        message: `Last backup ${hours(age)} hours ago.`,
        details: [],
        fix: 'Check Settings › Backups.',
      };
    }
    return {
      key: 'backup',
      level: 'green',
      message: `Backed up ${age < HOUR ? 'within the hour' : `${hours(age)} h ago`}.`,
      details: [],
    };
  }
  const age = ago(f.now, b.savedElsewhereAt);
  if (age == null || age > 7 * DAY) {
    return {
      key: 'backup',
      level: 'amber',
      message:
        age == null
          ? 'No backup has been saved off this till.'
          : `No backup saved off this till for ${Math.floor(age / DAY)} days.`,
      details: [],
      fix: 'Switch on automatic backups in Settings › Backups, or use File › Save Backup To… on the till.',
    };
  }
  return {
    key: 'backup',
    level: 'green',
    message: `Backup saved ${Math.floor(age / DAY)} day(s) ago.`,
    details: [],
  };
}

export function devicesLight(f: StatusFacts): StatusLight {
  const d = f.devices;
  const older = d.older.reduce((a, o) => a + o.devices, 0);
  const details = d.older.map((o) => `${o.devices} on ${o.version}`);
  if (older > 0) {
    return {
      key: 'devices',
      level: 'amber',
      message: `${older} device(s) on an older app than this till (${d.tillVersion}).`,
      details,
      fix: 'Update the Waiter app and KDS on those devices: some features need the same version.',
    };
  }
  return {
    key: 'devices',
    level: 'green',
    message: d.online
      ? `${d.online} device(s) connected, all up to date.`
      : 'No phones or kitchen screens connected.',
    details,
  };
}

const DISK_RED = 500 * 1024 ** 2;
const DISK_AMBER = 2 * 1024 ** 3;

export function databaseLight(f: StatusFacts): StatusLight {
  const x = f.database;
  if (x.freeBytes != null && x.freeBytes < DISK_RED) {
    return {
      key: 'database',
      level: 'red',
      message: 'The till is nearly out of disk space: sales may fail to save.',
      details: [],
      fix: 'Free up space on the till computer now.',
    };
  }
  const busy = ago(f.now, x.lastBusyAt);
  if (busy != null && busy < 5 * 60_000) {
    return {
      key: 'database',
      level: 'amber',
      message: 'The till was busy a moment ago: a request had to be retried.',
      details: [],
      fix: 'Nothing was lost. If it keeps happening, restart the till when service is quiet.',
    };
  }
  if (x.freeBytes != null && x.freeBytes < DISK_AMBER) {
    return {
      key: 'database',
      level: 'amber',
      message: 'Disk space is low on the till.',
      details: [],
      fix: 'Free up space on the till computer.',
    };
  }
  return { key: 'database', level: 'green', message: 'Healthy.', details: [] };
}

export function aggregateStatusLights(f: StatusFacts): StatusLight[] {
  return [
    fiscalLight(f),
    printersLight(f),
    backupLight(f),
    devicesLight(f),
    databaseLight(f),
  ];
}

/** Keys that just turned red (for the optional alert sound). */
export function newlyRed(
  prev: StatusLight[] | null,
  next: StatusLight[],
): LightKey[] {
  const was = new Map((prev || []).map((l) => [l.key, l.level]));
  return next
    .filter(
      (l) => l.level === 'red' && was.get(l.key) !== 'red' && prev != null,
    )
    .map((l) => l.key);
}

/** Plain-language reason for a sale on the review list. */
export function plainReviewReason(
  kind: string,
  lastError?: string | null,
): string {
  const err = String(lastError || '');
  if (/500[ ,.]?000|100[ ,.]?000/.test(err) && /ALL/.test(err)) {
    return 'The tax service refused it: cash over the legal limit for one bill. Take it by card or issue the invoice in easyPos.';
  }
  switch (kind) {
    case 'rejected':
      return `The tax service refused the invoice${err ? `: ${err.slice(0, 160)}` : '.'} Fix the cause, then send it again.`;
    case 'not-sent':
      return 'The invoice was never sent. Send it now.';
    case 'unknown-outcome':
      return "The till doesn't know if the tax service received it. Look it up in easyPos first, then say what you found.";
    case 'correction-required':
      return 'The sale changed after it was filed (a void or refund). A correcting invoice is needed.';
    case 'unrecorded':
      return 'The tax service has an invoice the till never saved as a sale. Check it in easyPos.';
    default:
      return err || 'Needs a person to look at it.';
  }
}
