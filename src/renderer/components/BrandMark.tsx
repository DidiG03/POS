import { useTranslation } from 'react-i18next';

type BrandSize = 'sm' | 'md' | 'lg';

const ICON: Record<BrandSize, string> = {
  sm: 'size-[18px]',
  md: 'size-6',
  lg: 'size-8',
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

export function BrandOrbitIcon({
  className = '',
  title,
}: {
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <rect
        x="3.5"
        y="3.5"
        width="25"
        height="25"
        rx="5.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M11 11.5h10M11 16h7.5M11 20.5h5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function BrandMark({
  size = 'md',
  compact = false,
  wordmark = true,
  subtitle,
  className = '',
}: {
  size?: BrandSize;
  compact?: boolean;
  wordmark?: boolean;
  subtitle?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const name = t('brand.name');
  const line = subtitle ?? t('brand.tagline');

  return (
    <div
      className={`flex min-w-0 items-center ${compact ? 'gap-2' : 'gap-2.5'} ${className}`}
    >
      <span className="pos-brand-mark shrink-0">
        <BrandOrbitIcon className={ICON[size]} />
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
