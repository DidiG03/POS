import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { isLanHttpClient } from '../utils/backendHost';
import { openPosServerScan } from '../utils/posServerScanEvent';

const ICON_HOLD_MS = 2000;

type BrandSize = 'sm' | 'md' | 'lg';

const ICON: Record<BrandSize, string> = {
  sm: 'size-8',
  md: 'size-9',
  lg: 'size-14',
};

const TITLE: Record<BrandSize, string> = {
  sm: 'text-[13px] leading-tight',
  md: 'text-[15px] leading-tight',
  lg: 'text-[18px] leading-tight',
};

const SUB: Record<BrandSize, string> = {
  sm: 'text-[11px]',
  md: 'text-[11px]',
  lg: 'text-[12px]',
};

/** Circular OneTap mark — rings on a blue disc, no square backdrop. */
export function BrandOrbitIcon({
  className = '',
  title,
}: {
  className?: string;
  title?: string;
}) {
  const gid = useId().replace(/:/g, '');
  const fill = `onetap-disc-${gid}`;
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`block ${className}`}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <radialGradient id={fill} cx="50%" cy="36%" r="64%">
          <stop offset="0%" stopColor="#6b8ae8" />
          <stop offset="42%" stopColor="#2f4db8" />
          <stop offset="100%" stopColor="#12183a" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="31" fill={`url(#${fill})`} />
      <circle cx="32" cy="32" r="30" stroke="#F0EEF8" strokeWidth="3.25" />
      <circle cx="32" cy="32" r="21.5" stroke="#fff" strokeWidth="1.7" />
      <circle cx="32" cy="32" r="14.75" stroke="#fff" strokeWidth="1.7" />
      <circle cx="32" cy="32" r="8.25" stroke="#fff" strokeWidth="1.7" />
      <circle cx="32" cy="32" r="3.35" fill="#fff" />
    </svg>
  );
}

export function BrandMark({
  size = 'md',
  compact = false,
  wordmark = true,
  subtitle,
  className = '',
  holdToScan,
}: {
  size?: BrandSize;
  compact?: boolean;
  wordmark?: boolean;
  subtitle?: string;
  className?: string;
  /** LAN waiter/KDS: hold the icon ~2s to reopen Scan. */
  holdToScan?: boolean;
}) {
  const { t } = useTranslation();
  const name = t('brand.name');
  const line = subtitle ?? t('brand.tagline');
  const holdTimer = useRef<number | null>(null);
  const canChangeServer = holdToScan ?? isLanHttpClient();

  const clearHold = () => {
    if (holdTimer.current != null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  useEffect(() => clearHold, []);

  const iconHold = canChangeServer
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          if (e.button !== 0) return;
          clearHold();
          holdTimer.current = window.setTimeout(() => {
            holdTimer.current = null;
            openPosServerScan();
          }, ICON_HOLD_MS);
        },
        onPointerUp: clearHold,
        onPointerCancel: clearHold,
        onPointerLeave: clearHold,
        onContextMenu: (e: React.SyntheticEvent) => {
          e.preventDefault();
        },
      }
    : undefined;

  return (
    <div
      className={`flex min-w-0 items-center ${compact ? 'gap-2' : 'gap-2.5'} ${className}`}
    >
      <span
        className={`pos-brand-mark shrink-0 ${canChangeServer ? 'pos-brand-mark--hold' : ''}`}
        aria-label={canChangeServer ? t('boot.holdIconToScan') : undefined}
        {...iconHold}
      >
        <BrandOrbitIcon
          className={ICON[size]}
          title={wordmark ? undefined : name}
        />
      </span>
      {wordmark ? (
        <div className="min-w-0 leading-none">
          <div
            className={`truncate font-semibold tracking-tight text-gray-50 ${TITLE[size]}`}
          >
            {name}
          </div>
          {line ? (
            <div
              className={`mt-0.5 truncate font-medium text-gray-500 ${SUB[size]}`}
            >
              {line}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
