import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { readStoredFlag, writeStoredFlag } from '../utils/storedFlag';
import { IconChevronLeft, IconChevronRight } from './icons';
import { cn } from './ui/cn';

export function useStoredFlag(
  key: string,
  fallback = false,
): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(() => readStoredFlag(key, fallback));
  const set = (next: boolean) => {
    setValue(next);
    writeStoredFlag(key, next);
  };
  return [value, set];
}

export const ADMIN_RAIL_COLLAPSED_KEY = 'pos-ui-admin-rail-collapsed';
export const SETTINGS_NAV_COLLAPSED_KEY = 'pos-ui-settings-nav-collapsed';

export function SidebarCollapseToggle({
  collapsed,
  onToggle,
  className,
}: {
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = collapsed
    ? t('common.expandSidebar')
    : t('common.collapseSidebar');
  return (
    <button
      type="button"
      className={cn('sidebar-edge-toggle', className)}
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-expanded={!collapsed}
    >
      {collapsed ? <IconChevronRight /> : <IconChevronLeft />}
    </button>
  );
}
