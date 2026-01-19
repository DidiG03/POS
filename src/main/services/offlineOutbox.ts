import { prisma } from '@db/client';
import { cloudJson, getCloudConfig, hasCloudSession } from './cloud';

export type OutboxHttpMethod = 'POST' | 'PUT' | 'DELETE';

export type OutboxItem = {
  id: string;
  createdAt: string;
  method: OutboxHttpMethod;
  path: string;
  body?: any;
  requireAuth: boolean;
  // Used to coalesce “latest wins” operations like /tables/open and /covers/save
  dedupeKey?: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastError?: string | null;
};

const OUTBOX_KEY = 'offline:outbox';
let flushing = false;

function nowIso() {
  return new Date().toISOString();
}

function jitter(ms: number) {
  return Math.floor(ms * (0.8 + Math.random() * 0.4));
}

export function isLikelyOfflineError(e: any) {
  const msg = String(e?.message || e || '').toLowerCase();
  const code = String(e?.cause?.code || e?.code || '').toLowerCase();
  if (code.includes('enotfound') || code.includes('econnrefused') || code.includes('etimedout') || code.includes('econnreset')) return true;
  if (msg.includes('fetch failed')) return true;
  if (msg.includes('network')) return true;
  if (msg.includes('socket hang up')) return true;
  if (msg.includes('timed out') || msg.includes('timeout')) return true;
  if (msg.includes('unable to') && msg.includes('resolve')) return true;
  return false;
}

function shouldPauseOutboxOnError(e: any) {
  const msg = String(e?.message || e || '').toLowerCase();
  // Auth/session problems: don’t keep retrying in a tight loop
  if (msg.includes('not logged in')) return true;
  if (msg.includes('admin login required')) return true;
  if (msg.includes('forbidden') || msg.includes('unauthorized')) return true;
  return false;
}

async function readOutbox(): Promise<{ items: OutboxItem[] }> {
  const row = await prisma.syncState.findUnique({ where: { key: OUTBOX_KEY } }).catch(() => null);
  const value = (row?.valueJson as any) || null;
  const items = Array.isArray(value?.items) ? (value.items as any[]) : [];
  return {
    items: items
      .map((it) => ({
        id: String(it.id || ''),
        createdAt: String(it.createdAt || nowIso()),
        method: it.method as OutboxHttpMethod,
        path: String(it.path || ''),
        body: it.body,
        requireAuth: Boolean(it.requireAuth),
        dedupeKey: it.dedupeKey ? String(it.dedupeKey) : undefined,
        attempts: Number(it.attempts || 0),
        nextAttemptAt: it.nextAttemptAt ? String(it.nextAttemptAt) : null,
        lastError: it.lastError ? String(it.lastError) : null,
      }))
      .filter((it) => it.id && it.method && it.path),
  };
}

async function writeOutbox(items: OutboxItem[]) {
  await prisma.syncState.upsert({
    where: { key: OUTBOX_KEY },
    create: { key: OUTBOX_KEY, valueJson: { items } },
    update: { valueJson: { items } },
  });
}

export async function enqueueOutbox(input: Omit<OutboxItem, 'attempts' | 'createdAt' | 'nextAttemptAt'> & { createdAt?: string }) {
  const cur = await readOutbox();
  const createdAt = input.createdAt || nowIso();
  const next: OutboxItem = {
    id: input.id,
    createdAt,
    method: input.method,
    path: input.path,
    body: input.body,
    requireAuth: input.requireAuth,
    dedupeKey: input.dedupeKey,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
  };

  let items = cur.items.slice();
  if (next.dedupeKey) {
    // Remove older entries with same dedupeKey (latest wins)
    items = items.filter((it) => it.dedupeKey !== next.dedupeKey);
  }
  items.push(next);
  // Keep bounded
  if (items.length > 500) items = items.slice(items.length - 500);
  await writeOutbox(items);
  return { queued: items.length };
}

export async function getOutboxStatus() {
  const cur = await readOutbox();
  return { queued: cur.items.length };
}

export async function flushOutboxOnce(): Promise<{ sent: number; remaining: number; paused?: boolean; lastError?: string }> {
  if (flushing) return { sent: 0, remaining: (await readOutbox()).items.length };
  flushing = true;
  try {
    const cfg = await getCloudConfig().catch(() => null);
    if (!cfg) return { sent: 0, remaining: (await readOutbox()).items.length };
    if (!hasCloudSession(cfg.businessCode)) return { sent: 0, remaining: (await readOutbox()).items.length, paused: true, lastError: 'not logged in' };

    const cur = await readOutbox();
    const items = cur.items.slice();
    const now = Date.now();
    let sent = 0;
    let changed = false;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const dueAt = it.nextAttemptAt ? new Date(it.nextAttemptAt).getTime() : 0;
      if (Number.isFinite(dueAt) && dueAt > now) continue;

      try {
        await cloudJson(it.method, it.path, it.body, { requireAuth: it.requireAuth, senderId: 0 });
        items.splice(i, 1);
        i -= 1;
        sent += 1;
        changed = true;
      } catch (e: any) {
        const msg = String(e?.message || e || 'request failed');
        if (shouldPauseOutboxOnError(e)) {
          // Stop processing; user likely needs to re-login.
          it.lastError = msg;
          it.nextAttemptAt = new Date(Date.now() + jitter(60_000)).toISOString();
          changed = true;
          if (changed) await writeOutbox(items);
          return { sent, remaining: items.length, paused: true, lastError: msg };
        }

        // Backoff for network/server errors
        it.attempts = Math.min(20, Number(it.attempts || 0) + 1);
        const backoffMs = Math.min(5 * 60_000, 1000 * Math.pow(2, Math.min(8, it.attempts)));
        it.nextAttemptAt = new Date(Date.now() + jitter(backoffMs)).toISOString();
        it.lastError = msg;
        changed = true;

        // If it's likely still offline, don't spin on later items
        if (isLikelyOfflineError(e)) break;
      }
    }

    if (changed) await writeOutbox(items);
    return { sent, remaining: items.length };
  } finally {
    flushing = false;
  }
}

let outboxTimer: any = null;
export function startOutboxLoop() {
  if (outboxTimer) return;
  outboxTimer = setInterval(() => {
    void flushOutboxOnce();
  }, 5000);
  void flushOutboxOnce();
}

