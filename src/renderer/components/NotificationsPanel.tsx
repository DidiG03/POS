import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  formatNotificationTime,
  groupNotifications,
  notificationHref,
  parseNotification,
  type NotificationKind,
  type NotificationTone,
} from '@shared/notificationDisplay';
import { Badge, EmptyState, cn } from './ui';
import { IconBell, IconChevronDown, IconChevronRight } from './icons';

export type NotificationRow = {
  id: number;
  type?: string;
  message: string;
  readAt: string | null;
  createdAt: string;
};

const GROUP_KEY: Record<NotificationKind, string> = {
  fiscal: 'inbox.groupFiscal',
  security: 'inbox.groupSecurity',
  ticket: 'inbox.groupTicket',
  shift: 'inbox.groupShift',
  request: 'inbox.groupRequest',
  other: 'inbox.groupOther',
};

const TONE: Record<NotificationTone, 'danger' | 'warn' | 'neutral'> = {
  danger: 'danger',
  warn: 'warn',
  neutral: 'neutral',
};

export function NotificationsPanel({
  items,
  empty,
  admin = true,
  onNavigate,
}: {
  items: NotificationRow[];
  empty?: string;
  admin?: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const groups = useMemo(() => groupNotifications(items), [items]);

  if (!items.length) {
    return (
      <EmptyState
        compact
        icon={<IconBell />}
        title={empty || t('common.noNotifications')}
      />
    );
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <section key={group.kind}>
          <div className="pos-section-label mb-1.5 px-1">
            {t(GROUP_KEY[group.kind])}
          </div>
          <ul className="space-y-1">
            {group.items.map((row) => (
              <NotificationCard
                key={row.id}
                row={row}
                admin={admin}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function NotificationCard({
  row,
  admin,
  onNavigate,
}: {
  row: NotificationRow;
  admin: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const parsed = parseNotification(row.message, row.type);
  const href = notificationHref(parsed, { createdAt: row.createdAt, admin });
  const unread = !row.readAt;
  const [open, setOpen] = useState(false);
  const summary = parsed.summaryKey
    ? t(parsed.summaryKey, parsed.summaryParams)
    : '';
  const extras = parsed.summaryParams?.extras
    ? String(parsed.summaryParams.extras)
    : '';
  const openHint = href?.pathname.startsWith('/admin/settings')
    ? t('inbox.openFiscal')
    : href?.pathname.startsWith('/admin/tickets')
      ? t('inbox.openTicket')
      : href?.pathname === '/admin'
        ? t('inbox.openStaff')
        : href?.pathname.startsWith('/app/tables')
          ? t('inbox.openTable')
          : t('inbox.openHint');

  const go = () => {
    if (!href) return;
    navigate(`${href.pathname}${href.search}`);
    onNavigate?.();
  };

  return (
    <li
      className={cn(
        'rounded-lg border px-2.5 py-2 text-left',
        unread
          ? 'border-white/12 bg-white/[0.05]'
          : 'border-transparent bg-white/3',
        href &&
          'cursor-pointer transition-colors hover:border-white/18 hover:bg-white/[0.07]',
      )}
    >
      <button
        type="button"
        className="block w-full text-left"
        onClick={go}
        disabled={!href}
        aria-label={
          href
            ? `${t(parsed.titleKey, parsed.titleParams)}${parsed.where ? ` · ${parsed.where}` : ''} · ${openHint}`
            : undefined
        }
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={TONE[parsed.tone]} dot>
                {t(parsed.titleKey, parsed.titleParams)}
              </Badge>
              {parsed.where ? (
                <span className="truncate text-[11px] font-medium text-gray-400">
                  {parsed.where}
                </span>
              ) : null}
            </div>
            {summary ? (
              <p className="mt-1 text-[12px] leading-snug text-gray-300">
                {summary}
                {extras ? (
                  <span className="text-gray-500"> · {extras}</span>
                ) : null}
              </p>
            ) : null}
            {href ? (
              <p className="mt-1 flex items-center gap-0.5 text-[11px] font-medium text-sky-300/90">
                {openHint}
                <IconChevronRight className="size-3.5" />
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span className="text-[11px] text-gray-500 tabular">
              {formatNotificationTime(row.createdAt, t)}
            </span>
            {unread ? (
              <Badge tone="accent">{t('common.newBadge')}</Badge>
            ) : null}
          </div>
        </div>
      </button>
      {parsed.detail ? (
        <button
          type="button"
          className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-gray-500 hover:text-gray-300"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          <IconChevronDown
            className={cn(
              'size-3.5 transition-transform',
              open ? 'rotate-180' : '',
            )}
          />
          {open ? t('inbox.hideDetails') : t('inbox.showDetails')}
        </button>
      ) : null}
      {open && parsed.detail ? (
        <p className="mt-1 break-words font-mono text-[11px] leading-relaxed text-gray-500">
          {parsed.detail}
        </p>
      ) : null}
    </li>
  );
}
