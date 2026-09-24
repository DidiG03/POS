import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNotificationTime } from '@shared/notificationDisplay';
import { NotificationsPanel, type NotificationRow } from './NotificationsPanel';
import { Button } from './ui/Button';
import { SpinnerGlyph } from './SpinnerGlyph';
import { reportAppError } from '../utils/reportAppError';

export function emitNotificationsUnread(count: number): void {
  try {
    window.dispatchEvent(
      new CustomEvent('pos:notificationsUnread', { detail: { count } }),
    );
  } catch {
    // ignore
  }
}

export function NotificationsInbox({
  userId,
  admin = false,
  hasTables = false,
  compact = false,
  refreshKey = 0,
  onCount,
  onNavigate,
  onReady,
}: {
  userId: number;
  admin?: boolean;
  hasTables?: boolean;
  compact?: boolean;
  refreshKey?: number;
  onCount?: (n: number) => void;
  onNavigate?: () => void;
  /** Fires once the first fetch for this inbox has finished. */
  onReady?: () => void;
}) {
  const [listReady, setListReady] = useState(false);
  const [requestsReady, setRequestsReady] = useState(!hasTables);
  const ready = listReady && requestsReady;
  const readySent = useRef(false);
  const onListReady = useCallback(() => setListReady(true), []);
  const onRequestsReady = useCallback(() => setRequestsReady(true), []);

  useEffect(() => {
    if (!ready || readySent.current) return;
    readySent.current = true;
    onReady?.();
  }, [ready, onReady]);

  return (
    <>
      {!ready && compact ? (
        <div className="flex items-center justify-center py-8">
          <SpinnerGlyph className="size-5 text-[color:var(--pos-fg-muted)]" />
        </div>
      ) : null}
      <div className={ready ? undefined : 'hidden'} aria-hidden={!ready}>
        <NotificationsList
          userId={userId}
          admin={admin}
          refreshKey={refreshKey}
          onCount={onCount}
          onNavigate={onNavigate}
          onReady={onListReady}
        />
        {hasTables ? (
          <OwnerRequests userId={userId} onReady={onRequestsReady} />
        ) : null}
      </div>
    </>
  );
}

function NotificationsList({
  userId,
  admin = false,
  refreshKey = 0,
  onCount,
  onNavigate,
  onReady,
}: {
  userId: number;
  admin?: boolean;
  refreshKey?: number;
  onCount?: (n: number) => void;
  onNavigate?: () => void;
  onReady?: () => void;
}) {
  const [items, setItems] = useState<NotificationRow[]>([]);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onCountRef = useRef(onCount);
  onCountRef.current = onCount;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const all = await window.api.notifications.list(userId).catch(() => []);
      if (cancelled) return;
      const rows = Array.isArray(all) ? all : [];
      setItems(rows);
      const unread = rows.filter((n) => !n?.readAt).length;
      onCountRef.current?.(unread);
      emitNotificationsUnread(unread);
      onReadyRef.current?.();
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, refreshKey]);

  const filtered = items.filter(
    (n) => !/requested to add items/i.test(n.message),
  );
  return (
    <NotificationsPanel
      items={filtered}
      admin={admin}
      onNavigate={onNavigate}
    />
  );
}

function OwnerRequests({
  userId,
  onReady,
}: {
  userId: number;
  onReady?: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<
    Array<{
      id: number;
      area: string;
      tableLabel: string;
      requesterId: number;
      items: any[];
      note?: string | null;
      createdAt: string;
    }>
  >([]);
  // A tablet on shaky Wi-Fi gets double-tapped. Without this the same request
  // is decided twice, and the second decision runs against a row the host has
  // already moved on from.
  const [deciding, setDeciding] = useState<number | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await window.api.requests.listForOwner(userId).catch(() => []);
      if (cancelled) return;
      setRows(r);
      onReadyRef.current?.();
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!rows.length) return null;
  return (
    <div className="mt-2 border-t border-[var(--pos-border)] pt-2">
      <div className="pos-section-label mb-1.5 px-1">
        {t('layout.orderRequests')}
      </div>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.id} className="pos-order-card !p-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 truncate text-[13px] font-medium">
                {t('layout.requestNumber', {
                  area: r.area,
                  table: r.tableLabel,
                  id: r.id,
                })}
              </div>
              <span className="shrink-0 text-[11px] tabular-nums text-[color:var(--pos-fg-muted)]">
                {formatNotificationTime(r.createdAt, t)}
              </span>
            </div>
            {r.note && (
              <div className="mt-0.5 text-[12px] text-[color:var(--pos-fg-muted)]">
                {r.note}
              </div>
            )}
            <div className="mt-1.5 text-[12px]">
              {Array.isArray(r.items) && r.items.length ? (
                <ul className="space-y-0.5">
                  {r.items.map((it: any, idx: number) => (
                    <li key={idx} className="flex justify-between gap-2">
                      <span className="truncate">
                        {String(it.name || t('common.item'))}
                      </span>
                      <span className="shrink-0 tabular-nums text-[color:var(--pos-fg-muted)]">
                        ×{Number(it.qty || 1)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-[color:var(--pos-fg-muted)]">
                  {t('common.noItems')}
                </div>
              )}
            </div>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={deciding != null}
                onClick={async () => {
                  if (deciding != null) return;
                  setDeciding(r.id);
                  try {
                    await window.api.requests.approve(r.id, userId);
                    setRows((prev) => prev.filter((x) => x.id !== r.id));
                  } catch (e) {
                    reportAppError(e, {
                      fallback: t('layout.requestDecideFailed'),
                      key: `requests.approve:${r.id}`,
                    });
                  } finally {
                    setDeciding(null);
                  }
                }}
              >
                {t('common.approve')}
              </Button>
              <Button
                size="sm"
                disabled={deciding != null}
                onClick={async () => {
                  if (deciding != null) return;
                  setDeciding(r.id);
                  try {
                    await window.api.requests.reject(r.id, userId);
                    setRows((prev) => prev.filter((x) => x.id !== r.id));
                  } catch (e) {
                    reportAppError(e, {
                      fallback: t('layout.requestDecideFailed'),
                      key: `requests.reject:${r.id}`,
                    });
                  } finally {
                    setDeciding(null);
                  }
                }}
              >
                {t('common.reject')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
