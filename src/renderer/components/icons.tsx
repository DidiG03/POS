import type { ReactNode } from 'react';

/**
 * One icon set for the whole renderer. Every glyph is a 24px outline drawn on
 * the same 1.6 stroke so mixed toolbars stay optically consistent — the
 * previous per-file inline SVGs drifted between 1.5, 1.75 and filled shapes.
 */
function Icon({
  children,
  className = 'pos-icon',
  fill,
}: {
  children: ReactNode;
  className?: string;
  fill?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? undefined : 'currentColor'}
      strokeWidth={fill ? undefined : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

type P = { className?: string };

export function IconTables({ className }: P) {
  return (
    <Icon className={className}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
    </Icon>
  );
}

export function IconReports({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </Icon>
  );
}

export function IconClock({ className }: P) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </Icon>
  );
}

export function IconLogout({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M15 4.5h2.5A2.5 2.5 0 0 1 20 7v10a2.5 2.5 0 0 1-2.5 2.5H15" />
      <path d="M11 16l4-4-4-4M15 12H4" />
    </Icon>
  );
}

export function IconBell({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M18 15.5V10a6 6 0 1 0-12 0v5.5L4.5 18h15L18 15.5Z" />
      <path d="M9.5 18a2.5 2.5 0 0 0 5 0" />
    </Icon>
  );
}

export function IconClose({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  );
}

export function IconSearch({ className }: P) {
  return (
    <Icon className={className}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </Icon>
  );
}

export function IconPlus({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function IconMinus({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M5 12h14" />
    </Icon>
  );
}

export function IconCheck({ className }: P) {
  return (
    <Icon className={className}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Icon>
  );
}

export function IconTrash({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M4.5 7h15M9.5 7V5.5A1 1 0 0 1 10.5 4.5h3a1 1 0 0 1 1 1V7" />
      <path d="M6.5 7l.8 11a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7" />
      <path d="M10.5 11v5.5M13.5 11v5.5" />
    </Icon>
  );
}

export function IconEdit({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M4.5 19.5h4L19 9a2.1 2.1 0 0 0-3-3L5.5 16.5v3Z" />
      <path d="m14.5 6.5 3 3" />
    </Icon>
  );
}

export function IconSettings({ className }: P) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2M12 18.5v2M5.5 12h-2M20.5 12h-2M7.4 7.4 6 6M18 18l-1.4-1.4M16.6 7.4 18 6M6 18l1.4-1.4" />
    </Icon>
  );
}

export function IconUsers({ className }: P) {
  return (
    <Icon className={className}>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19.5c0-3 2.5-4.8 5.5-4.8s5.5 1.8 5.5 4.8" />
      <path d="M16 6.2a3 3 0 0 1 0 5.9M17.5 14.9c1.9.5 3 1.9 3 4.6" />
    </Icon>
  );
}

export function IconUser({ className }: P) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c0-3.3 3.1-5.3 7-5.3s7 2 7 5.3" />
    </Icon>
  );
}

export function IconPrinter({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M7 9V4.5h10V9" />
      <path d="M7 17H5.5A1.5 1.5 0 0 1 4 15.5v-5A1.5 1.5 0 0 1 5.5 9h13a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H17" />
      <rect x="7" y="14" width="10" height="5.5" rx="1" />
    </Icon>
  );
}

export function IconChart({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M4 16.5 9 11l3.5 3.5L20 7" />
      <path d="M15 7h5v5" />
    </Icon>
  );
}

export function IconList({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />
    </Icon>
  );
}

export function IconGrid({ className }: P) {
  return (
    <Icon className={className}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </Icon>
  );
}

export function IconRefresh({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.6-5.7" />
      <path d="M19.8 4.5v4h-4" />
    </Icon>
  );
}

export function IconCalendar({ className }: P) {
  return (
    <Icon className={className}>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2" />
      <path d="M4 10h16M8.5 3.5V7M15.5 3.5V7" />
    </Icon>
  );
}

export function IconFilter({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M4.5 6.5h15M7.5 12h9M10.5 17.5h3" />
    </Icon>
  );
}

export function IconChevronLeft({ className }: P) {
  return (
    <Icon className={className}>
      <path d="m14 6-6 6 6 6" />
    </Icon>
  );
}

export function IconChevronRight({ className }: P) {
  return (
    <Icon className={className}>
      <path d="m10 6 6 6-6 6" />
    </Icon>
  );
}

export function IconChevronDown({ className }: P) {
  return (
    <Icon className={className}>
      <path d="m6 10 6 6 6-6" />
    </Icon>
  );
}

export function IconArrowLeft({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M19 12H5m0 0 6-6m-6 6 6 6" />
    </Icon>
  );
}

export function IconAlert({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M12 4.5 21 19.5H3L12 4.5Z" />
      <path d="M12 10v4M12 16.8h.01" />
    </Icon>
  );
}

export function IconInfo({ className }: P) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 8h.01" />
    </Icon>
  );
}

export function IconCard({ className }: P) {
  return (
    <Icon className={className}>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M3 10h18M6.5 14.5h4" />
    </Icon>
  );
}

export function IconCash({ className }: P) {
  return (
    <Icon className={className}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6.5 12h.01M17.5 12h.01" />
    </Icon>
  );
}

export function IconBox({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M12 3.5 20 7.5v9L12 20.5 4 16.5v-9l8-4Z" />
      <path d="M4 7.5 12 11.5l8-4M12 11.5v9" />
    </Icon>
  );
}

export function IconTicket({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M4.5 8.5A2 2 0 0 1 6.5 6.5h11a2 2 0 0 1 2 2v1.2a2.3 2.3 0 0 0 0 4.6v1.2a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-1.2a2.3 2.3 0 0 0 0-4.6V8.5Z" />
      <path d="M12 9v6" />
    </Icon>
  );
}

export function IconMenuBook({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M5 5.5h6a2 2 0 0 1 2 2v11a1.6 1.6 0 0 0-1.6-1.6H5V5.5Z" />
      <path d="M19 5.5h-6a2 2 0 0 0-2 2v11a1.6 1.6 0 0 1 1.6-1.6H19V5.5Z" />
    </Icon>
  );
}

export function IconKitchen({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M6 4.5V10a2.5 2.5 0 0 0 5 0V4.5M8.5 12.5v7" />
      <path d="M16.5 4.5c-1.4 1.4-1.4 3.6 0 5v10" />
    </Icon>
  );
}

export function IconSplit({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M4.5 7h4l4 5h7M4.5 17h4l2.3-2.9" />
      <path d="M17 4.5 19.5 7 17 9.5M17 14.5 19.5 17 17 19.5" />
    </Icon>
  );
}

export function IconMerge({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M4.5 6.5h3.2l4.3 5.5h7M4.5 17.5h3.2l2.4-3" />
      <path d="M16.5 9.5 19.5 12l-3 2.5" />
    </Icon>
  );
}

export function IconMore({ className }: P) {
  return (
    <Icon className={className} fill>
      <circle cx="6" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="18" cy="12" r="1.6" />
    </Icon>
  );
}

export function IconLock({ className }: P) {
  return (
    <Icon className={className}>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </Icon>
  );
}

export function IconWifiOff({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M3 4l18 16" />
      <path d="M5 10.5a11 11 0 0 1 4-2.4M15.5 8.6a11 11 0 0 1 3.5 1.9M8.5 14a6.5 6.5 0 0 1 2-1.2M12 17.8h.01" />
    </Icon>
  );
}

export function IconDownload({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M12 4.5v10m0 0 4-4m-4 4-4-4" />
      <path d="M5 17.5v1a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1" />
    </Icon>
  );
}

export function IconUpload({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M12 15.5v-10m0 0 4 4m-4-4-4 4" />
      <path d="M5 17.5v1a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1" />
    </Icon>
  );
}

export function IconMoveRight({ className }: P) {
  return (
    <Icon className={className}>
      <path d="M5 12h14m0 0-5-5m5 5-5 5" />
    </Icon>
  );
}
