import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/session';
import { useLicenseCapabilities } from '../../stores/licenseCapabilities';
import { NotificationsInbox, emitNotificationsUnread } from '../../components/NotificationsInbox';
import { IconBell } from '../../components/icons';
import { EmptyState } from '../../components/ui';
import { reportAppError } from '../../utils/reportAppError';

export default function NotificationsPage() {
  const { t } = useTranslation();
  const user = useSessionStore((s) => s.user);
  const hasTables = useLicenseCapabilities((s) => s.hasTables);
  const [unreadCount, setUnreadCount] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const onCount = useCallback((n: number) => {
    setUnreadCount(n);
  }, []);

  if (!user) {
    return (
      <EmptyState
        icon={<IconBell />}
        title={t('common.noNotifications')}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <div className="mb-3 flex shrink-0 items-center justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight">
          {t('layout.notifications')}
        </h2>
        {unreadCount > 0 ? (
          <button
            className="rounded px-1 text-[12px] font-medium text-[color:var(--pos-fg-muted)] hover:text-[color:var(--pos-fg)]"
            style={{ minHeight: 0 }}
            type="button"
            onClick={async () => {
              try {
                await window.api.notifications.markAllRead(user.id);
                setUnreadCount(0);
                emitNotificationsUnread(0);
                setRefreshKey((n) => n + 1);
              } catch (e) {
                reportAppError(e, {
                  fallback: t('common.actionFailed'),
                  key: `notifications.markAll:${user.id}`,
                });
              }
            }}
          >
            {t('common.markAllRead')}
          </button>
        ) : null}
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
        <NotificationsInbox
          userId={user.id}
          admin={String(user.role || '').toUpperCase() === 'ADMIN'}
          hasTables={hasTables}
          refreshKey={refreshKey}
          onCount={onCount}
        />
      </div>
    </div>
  );
}
