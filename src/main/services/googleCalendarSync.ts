import { prisma } from '@db/client';
import type { GoogleCalendarSyncResultDTO } from '@shared/ipc';
import { broadcastReservationsChanged } from './realtime';
import {
  fetchGoogleCalendarApiEvents,
  getGoogleOAuthClientConfig,
  type StoredGoogleOAuth,
} from './googleCalendarOAuth';

export const GOOGLE_CALENDAR_SOURCE = 'GOOGLE_CALENDAR';

export type ParsedCalendarEvent = {
  uid: string;
  summary: string;
  description: string;
  startsAt: Date;
  endsAt: Date | null;
  cancelled: boolean;
};

export type CalendarEventFields = {
  customerName: string;
  customerPhone: string | null;
  partySize: number;
  area: string;
  tableLabel: string | null;
  note: string | null;
  startsAt: Date;
  durationMin: number;
  status: 'BOOKED' | 'CANCELLED';
};

export type GoogleCalendarConfig = {
  enabled?: boolean;
  authMode?: 'oauth' | 'ical';
  icalUrl?: string;
  calendarId?: string;
  oauth?: StoredGoogleOAuth | null;
  defaultArea?: string;
  defaultDurationMin?: number;
  onOAuthUpdated?: (oauth: StoredGoogleOAuth) => Promise<void>;
};

/** Unfold RFC 5545 continuation lines and split into raw logical lines. */
export function unfoldIcal(text: string): string[] {
  const raw = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const merged: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (merged.length) merged[merged.length - 1] += line.slice(1);
      continue;
    }
    merged.push(line);
  }
  return merged;
}

function unescapeIcalText(value: string): string {
  return String(value || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseIcalProperty(
  line: string,
): { name: string; value: string } | null {
  const idx = line.indexOf(':');
  if (idx <= 0) return null;
  const left = line.slice(0, idx);
  const value = unescapeIcalText(line.slice(idx + 1));
  const name = left.split(';')[0]?.trim().toUpperCase() || '';
  if (!name) return null;
  return { name, value };
}

/** Parse `20260613T190000` or `20260613T190000Z` into a Date. */
export function parseIcalDateTime(raw: string): Date | null {
  const v = String(raw || '').trim();
  if (!v) return null;
  if (/^\d{8}$/.test(v)) {
    const y = Number(v.slice(0, 4));
    const m = Number(v.slice(4, 6)) - 1;
    const d = Number(v.slice(6, 8));
    const dt = new Date(y, m, d, 0, 0, 0, 0);
    return Number.isFinite(dt.getTime()) ? dt : null;
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  if (m[7] === 'Z') {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    const dt = new Date(iso);
    return Number.isFinite(dt.getTime()) ? dt : null;
  }
  const dt = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    0,
  );
  return Number.isFinite(dt.getTime()) ? dt : null;
}

/** Extract VEVENT blocks from an iCal document. */
export function parseIcalEvents(text: string): ParsedCalendarEvent[] {
  const lines = unfoldIcal(text);
  const out: ParsedCalendarEvent[] = [];
  let inEvent = false;
  let current: Partial<ParsedCalendarEvent> = {};

  const flush = () => {
    const uid = String(current.uid || '').trim();
    const summary = String(current.summary || '').trim();
    const startsAt = current.startsAt;
    if (!uid || !summary || !startsAt) return;
    out.push({
      uid,
      summary,
      description: String(current.description || ''),
      startsAt,
      endsAt: current.endsAt ?? null,
      cancelled: Boolean(current.cancelled),
    });
  };

  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      inEvent = true;
      current = {};
      continue;
    }
    if (upper === 'END:VEVENT') {
      if (inEvent) flush();
      inEvent = false;
      current = {};
      continue;
    }
    if (!inEvent) continue;
    const prop = parseIcalProperty(line);
    if (!prop) continue;
    if (prop.name === 'UID') current.uid = prop.value;
    if (prop.name === 'SUMMARY') current.summary = prop.value;
    if (prop.name === 'DESCRIPTION') current.description = prop.value;
    if (prop.name === 'DTSTART') {
      const dt = parseIcalDateTime(prop.value);
      if (dt) current.startsAt = dt;
    }
    if (prop.name === 'DTEND') {
      const dt = parseIcalDateTime(prop.value);
      if (dt) current.endsAt = dt;
    }
    if (prop.name === 'STATUS' && prop.value.toUpperCase() === 'CANCELLED') {
      current.cancelled = true;
    }
  }
  return out;
}

function parseDescriptionFields(description: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of String(description || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^([a-zA-Z_][\w ]*)\s*:\s*(.+)$/);
    if (!m) continue;
    out[m[1].trim().toLowerCase().replace(/\s+/g, '_')] = m[2].trim();
  }
  return out;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** Map a calendar event + admin defaults into reservation fields. */
export function mapCalendarEventToReservation(
  event: ParsedCalendarEvent,
  config: GoogleCalendarConfig,
): CalendarEventFields {
  const fields = parseDescriptionFields(event.description);
  const defaultArea =
    String(config.defaultArea || 'Main Hall').trim() || 'Main Hall';
  const defaultDuration = clampInt(config.defaultDurationMin, 15, 720, 120);

  let customerName = String(event.summary || '').trim();
  let partySize = clampInt(
    fields.party ?? fields.party_size ?? fields.guests,
    1,
    200,
    2,
  );
  const partyInTitle = customerName.match(
    /\((\d+)\s*(?:p|people|guests|persons)?\)\s*$/i,
  );
  if (partyInTitle) {
    partySize = clampInt(partyInTitle[1], 1, 200, partySize);
    customerName = customerName
      .replace(/\((\d+)\s*(?:p|people|guests|persons)?\)\s*$/i, '')
      .trim();
  }
  if (!customerName) customerName = 'Guest';

  const startsAt = event.startsAt;
  let durationMin = defaultDuration;
  if (event.endsAt) {
    const diffMs = event.endsAt.getTime() - startsAt.getTime();
    if (diffMs > 0) {
      durationMin = clampInt(
        Math.round(diffMs / 60_000),
        15,
        720,
        defaultDuration,
      );
    }
  }

  const area =
    String(fields.area || fields.zone || fields.section || '').trim() ||
    defaultArea;
  const customerPhone =
    String(
      fields.phone || fields.tel || fields.mobile || fields.telefon || '',
    ).trim() || null;
  const note =
    String(
      fields.note || fields.notes || fields.comment || fields.comments || '',
    ).trim() || null;

  return {
    customerName,
    customerPhone,
    partySize,
    area,
    tableLabel: null,
    note,
    startsAt,
    durationMin,
    status: event.cancelled ? 'CANCELLED' : 'BOOKED',
  };
}

async function resolveSyncActorId(): Promise<number> {
  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN', active: true },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  if (admin) return Number(admin.id);
  const host = await prisma.user.findFirst({
    where: { role: 'HOST', active: true },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  if (host) return Number(host.id);
  throw new Error('No active admin or host user found for calendar sync');
}

function isFutureOrRecent(
  startsAt: Date,
  pastDays = 1,
  futureDays = 120,
): boolean {
  const now = Date.now();
  const lower = now - pastDays * 24 * 60 * 60 * 1000;
  const upper = now + futureDays * 24 * 60 * 60 * 1000;
  const t = startsAt.getTime();
  return t >= lower && t <= upper;
}

async function upsertCalendarReservation(args: {
  uid: string;
  actorId: number;
  fields: CalendarEventFields;
}): Promise<'created' | 'updated' | 'cancelled' | 'skipped'> {
  const existing = await prisma.reservation.findFirst({
    where: {
      externalSource: GOOGLE_CALENDAR_SOURCE,
      externalId: args.uid,
    },
  });

  if (args.fields.status === 'CANCELLED') {
    if (!existing) return 'skipped';
    if (String((existing as any).status) === 'CANCELLED') return 'skipped';
    const updated = await prisma.reservation.update({
      where: { id: Number((existing as any).id) },
      data: { status: 'CANCELLED' as any },
    });
    broadcastReservationsChanged({
      kind: 'status',
      id: Number(updated.id),
      dateIso: new Date(updated.startsAt).toISOString(),
      area: String(updated.area),
      status: 'CANCELLED',
    });
    return 'cancelled';
  }

  const data = {
    area: args.fields.area,
    tableLabel: null as string | null,
    customerName: args.fields.customerName,
    customerPhone: args.fields.customerPhone,
    partySize: args.fields.partySize,
    startsAt: args.fields.startsAt,
    durationMin: args.fields.durationMin,
    note: args.fields.note,
    status: 'BOOKED' as const,
    externalSource: GOOGLE_CALENDAR_SOURCE,
    externalId: args.uid,
    createdById: args.actorId,
  };

  if (existing) {
    const updated = await prisma.reservation.update({
      where: { id: Number((existing as any).id) },
      data: {
        area: data.area,
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        partySize: data.partySize,
        startsAt: data.startsAt,
        durationMin: data.durationMin,
        note: data.note,
        status:
          String((existing as any).status) === 'CANCELLED'
            ? ('BOOKED' as any)
            : ((existing as any).status as any),
      },
    });
    broadcastReservationsChanged({
      kind: 'updated',
      id: Number(updated.id),
      dateIso: new Date(updated.startsAt).toISOString(),
      area: String(updated.area),
      status: String(updated.status) as any,
    });
    return 'updated';
  }

  const created = await prisma.reservation.create({ data: data as any });
  broadcastReservationsChanged({
    kind: 'created',
    id: Number(created.id),
    dateIso: new Date(created.startsAt).toISOString(),
    area: String(created.area),
    status: String(created.status) as any,
  });
  return 'created';
}

export async function syncGoogleCalendarReservations(
  config: GoogleCalendarConfig,
): Promise<GoogleCalendarSyncResultDTO> {
  const enabled = Boolean(config?.enabled);
  if (!enabled) {
    return {
      ok: false,
      imported: 0,
      updated: 0,
      cancelled: 0,
      skipped: 0,
      error: 'Google Calendar sync is disabled',
    };
  }

  const oauthRefresh = String(config?.oauth?.refreshToken || '').trim();
  const icalUrl = String(config?.icalUrl || '').trim();
  const useOAuth = Boolean(oauthRefresh) || config.authMode === 'oauth';

  let events: ParsedCalendarEvent[] = [];

  if (useOAuth && oauthRefresh) {
    const { clientId, clientSecret, configured } = getGoogleOAuthClientConfig();
    if (!configured) {
      return {
        ok: false,
        imported: 0,
        updated: 0,
        cancelled: 0,
        skipped: 0,
        error: 'Google OAuth is not configured for this POS build',
      };
    }
    try {
      const fetched = await fetchGoogleCalendarApiEvents({
        oauth: config.oauth,
        calendarId: config.calendarId,
        clientId,
        clientSecret,
      });
      events = fetched.events;
      if (config.onOAuthUpdated) {
        await config.onOAuthUpdated(fetched.oauth);
      }
    } catch (e: any) {
      return {
        ok: false,
        imported: 0,
        updated: 0,
        cancelled: 0,
        skipped: 0,
        error: String(
          e?.message || e || 'Failed to fetch Google Calendar events',
        ),
      };
    }
  } else if (icalUrl) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    let body = '';
    try {
      const res = await fetch(icalUrl, {
        method: 'GET',
        headers: { Accept: 'text/calendar' },
        signal: ac.signal,
      });
      if (!res.ok) {
        throw new Error(`Calendar feed returned HTTP ${res.status}`);
      }
      body = await res.text();
    } catch (e: any) {
      const msg = String(e?.name || '')
        .toLowerCase()
        .includes('abort')
        ? 'Calendar feed request timed out'
        : String(e?.message || e || 'Failed to fetch calendar feed');
      return {
        ok: false,
        imported: 0,
        updated: 0,
        cancelled: 0,
        skipped: 0,
        error: msg,
      };
    } finally {
      clearTimeout(timer);
    }
    events = parseIcalEvents(body);
  } else {
    return {
      ok: false,
      imported: 0,
      updated: 0,
      cancelled: 0,
      skipped: 0,
      error: 'Connect Google Calendar or configure an iCal feed URL',
    };
  }

  const actorId = await resolveSyncActorId();
  let imported = 0;
  let updated = 0;
  let cancelled = 0;
  let skipped = 0;

  for (const event of events) {
    if (!isFutureOrRecent(event.startsAt)) {
      skipped += 1;
      continue;
    }
    const fields = mapCalendarEventToReservation(event, config);
    const result = await upsertCalendarReservation({
      uid: event.uid,
      actorId,
      fields,
    });
    if (result === 'created') imported += 1;
    else if (result === 'updated') updated += 1;
    else if (result === 'cancelled') cancelled += 1;
    else skipped += 1;
  }

  const total = imported + updated + cancelled;
  return {
    ok: true,
    imported,
    updated,
    cancelled,
    skipped,
    message:
      total > 0
        ? `Synced ${imported} new, ${updated} updated, ${cancelled} cancelled`
        : 'Calendar checked — no changes',
  };
}
