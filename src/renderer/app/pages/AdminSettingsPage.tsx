import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  FiscalReviewDTO,
  NetworkPrinterDTO,
  UpdateStatusDTO,
} from '@shared/ipc';
import { toast } from '../../stores/toasts';
import { ALL_KDS_STATIONS, type KdsStation } from '@shared/kdsStations';
import { KDS_BUMP_BAR_PROGRAMMING } from '../../utils/kdsBumpBar';
import FloorCanvas from '../components/FloorCanvas';
import {
  KebabMenu,
  SettingsCard,
  SettingsHeader,
  SettingsStatus,
  SettingsToggleRow,
} from '../components/SettingsChrome';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { cn } from '../../components/ui/cn';
import { useSessionStore } from '../../stores/session';
import { useAdminSessionStore } from '../../stores/adminSession';

type SectionKey =
  | 'printer'
  | 'areas'
  | 'googleCalendar'
  | 'kds'
  | 'preferences'
  | 'fiscal'
  | 'backups'
  | 'updates'
  | 'billing'
  | 'lan'
  | 'about';

const NAV_GROUPS: Array<{ labelKey: string; keys: SectionKey[] }> = [
  {
    labelKey: 'settingsNav.groupVenue',
    keys: ['printer', 'areas', 'kds', 'googleCalendar'],
  },
  {
    labelKey: 'settingsNav.groupOperations',
    keys: ['preferences', 'fiscal'],
  },
  {
    labelKey: 'settingsNav.groupSystem',
    keys: ['lan', 'backups', 'updates', 'billing', 'about'],
  },
];

function ChevronRight() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="pos-icon opacity-70"
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M9.22 4.22a.75.75 0 011.06 0l6 6a.75.75 0 010 1.06l-6 6a.75.75 0 11-1.06-1.06L14.94 12 9.22 5.28a.75.75 0 010-1.06z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function SectionIcon({ k }: { k: SectionKey }) {
  const common = {
    className: 'pos-icon shrink-0 opacity-80',
    'aria-hidden': true,
  } as any;
  if (k === 'printer')
    return (
      <svg {...common} viewBox="0 0 24 24" fill="none">
        <path
          d="M7 8V4h10v4M7 17h10v3H7v-3Z"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
        <path
          d="M6 17H5a3 3 0 0 1-3-3v-2a4 4 0 0 1 4-4h12a4 4 0 0 1 4 4v2a3 3 0 0 1-3 3h-1"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (k === 'areas')
    return (
      <svg {...common} viewBox="0 0 24 24" fill="none">
        <path
          d="M4 6h16M4 12h16M4 18h16"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
        <path
          d="M7 6v12M17 6v12"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          opacity="0.7"
        />
      </svg>
    );
  if (k === 'googleCalendar')
    return (
      <svg {...common} viewBox="0 0 24 24" fill="none">
        <path
          d="M7 3v2M17 3v2M4 9h16M6 5h12a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
        <path
          d="M8 13h3v3H8v-3ZM13 13h3v3h-3v-3Z"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (k === 'kds')
    return (
      <svg {...common} viewBox="0 0 24 24" fill="none">
        <path
          d="M4 5h16v10H4V5Z"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
        <path
          d="M8 19h8M12 15v4"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    );
  if (k === 'preferences')
    return (
      <svg {...common} viewBox="0 0 24 24" fill="none">
        <path
          d="M4 7h10M18 7h2M4 17h2M10 17h10"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
        <path
          d="M14 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM10 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z"
          stroke="currentColor"
          strokeWidth="1.75"
        />
      </svg>
    );
  if (k === 'fiscal')
    return (
      <svg {...common} viewBox="0 0 24 24" fill="none">
        <path
          d="M7 3h10v18H7V3Z"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
        <path
          d="M9 7h6M9 11h6M9 15h4"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    );
  if (k === 'backups')
    return (
      <svg {...common} viewBox="0 0 24 24" fill="none">
        <path
          d="M20 7.5A4.5 4.5 0 0 0 11.6 5 4 4 0 0 0 4 8.5C4 11 6 13 8.5 13H19a3 3 0 0 0 1-5.5Z"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
        <path
          d="M12 12v7m0 0-3-3m3 3 3-3"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (k === 'updates')
    return (
      <svg {...common} viewBox="0 0 24 24" fill="none">
        <path
          d="M20 12a8 8 0 1 1-2.34-5.66"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
        <path
          d="M20 4v6h-6"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (k === 'billing')
    return (
      <svg {...common} viewBox="0 0 24 24" fill="none">
        <path
          d="M3 7h18v10H3V7Z"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
        <path
          d="M3 10h18"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
        <path
          d="M7 14h4"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    );
  if (k === 'lan')
    return (
      <svg {...common} viewBox="0 0 24 24" fill="none">
        <path
          d="M12 19h.01"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <path
          d="M8.5 15.5a5 5 0 0 1 7 0"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
        <path
          d="M5 12a10 10 0 0 1 14 0"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          opacity="0.8"
        />
      </svg>
    );
  // about/business info
  return (
    <svg {...common} viewBox="0 0 24 24" fill="none">
      <path
        d="M12 17v-5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M12 8h.01"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
        stroke="currentColor"
        strokeWidth="1.75"
      />
    </svg>
  );
}

export default function AdminSettingsPage() {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<SectionKey>('printer');
  return (
    <div
      className="flex min-h-0 overflow-hidden rounded-lg border border-white/7 bg-[var(--pos-surface)]"
      style={{ minHeight: 'calc(100dvh - var(--pos-header-h) - 2.75rem)' }}
    >
      <nav className="flex w-[232px] shrink-0 flex-col overflow-y-auto border-r border-white/7 bg-[var(--pos-canvas)] p-2.5">
        {NAV_GROUPS.map((group) => (
          <div key={group.labelKey} className="mb-3 last:mb-0">
            <div className="pos-section-label px-2.5 pb-1.5 pt-1">
              {t(group.labelKey)}
            </div>
            <div className="space-y-0.5">
              {group.keys.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={cn(
                    'pos-side-link w-full',
                    selected === key
                      ? 'pos-side-link--active'
                      : 'pos-side-link--idle',
                  )}
                  onClick={() => setSelected(key)}
                >
                  <SectionIcon k={key} />
                  <span className="truncate">{t(`settingsNav.${key}`)}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-auto p-5">
        <div className="mx-auto max-w-3xl">
          {selected === 'printer' && <PrinterSettings />}
          {selected === 'areas' && <AreasSettings />}
          {selected === 'googleCalendar' && <GoogleCalendarSettings />}
          {selected === 'kds' && <KdsSettings />}
          {selected === 'preferences' && <PreferencesSettings />}
          {selected === 'fiscal' && <FiscalSettings />}
          {selected === 'backups' && <BackupsSettings />}
          {selected === 'updates' && <SystemUpdatesSettings />}
          {selected === 'billing' && <BillingSettings />}
          {selected === 'lan' && <LanSettings />}
          {selected === 'about' && <AboutSettings />}
        </div>
      </div>
    </div>
  );
}

function SystemUpdatesSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpdateStatusDTO | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);

  async function loadStatus() {
    try {
      const s = await window.api.updater.getUpdateStatus();
      setStatus(s);
    } catch {
      // ignore (updater may be unavailable)
    }
  }

  useEffect(() => {
    void loadStatus();
    const handleEvent = (e: any) => {
      const { event, data } = (e as CustomEvent<any>)?.detail || {};
      if (event === 'checking') {
        setChecking(true);
        setError(null);
      }
      if (event === 'update-available' || event === 'update-not-available') {
        setChecking(false);
        setLastCheckedAt(Date.now());
        void loadStatus();
      }
      if (event === 'download-progress') {
        setDownloadProgress(
          typeof data?.percent === 'number' ? data.percent : null,
        );
      }
      if (event === 'update-downloaded') {
        setDownloadProgress(null);
        void loadStatus();
      }
      if (event === 'error') {
        setChecking(false);
        setError(String(data?.message || t('settingsUpdates.errorGeneric')));
      }
    };
    window.addEventListener('updater:event', handleEvent as EventListener);
    return () =>
      window.removeEventListener('updater:event', handleEvent as EventListener);
  }, [t]);

  async function checkNow() {
    setChecking(true);
    setError(null);
    setLastCheckedAt(Date.now());
    try {
      const r = await window.api.updater.checkForUpdates();
      if (r?.error) setError(String(r.error));
    } catch (e: any) {
      setError(String(e?.message || t('settingsUpdates.errorCheck')));
    } finally {
      setChecking(false);
      void loadStatus();
    }
  }

  async function download() {
    setError(null);
    try {
      const r = await window.api.updater.downloadUpdate();
      if (r?.error) setError(String(r.error));
    } catch (e: any) {
      setError(String(e?.message || t('settingsUpdates.errorDownload')));
    }
  }

  async function install() {
    if (!confirm(t('settingsUpdates.installConfirm'))) return;
    try {
      await window.api.updater.installUpdate();
    } catch (e: any) {
      setError(String(e?.message || t('settingsUpdates.errorInstall')));
    }
  }

  const hasUpdate = Boolean(status?.hasUpdate && status?.updateInfo?.version);

  return (
    <div>
      <SettingsHeader
        title={t('settingsUpdates.title')}
        description={t('settingsUpdates.help')}
        actions={
          <>
            {hasUpdate && !status?.downloaded ? (
              <Button variant="primary" onClick={() => void download()}>
                {t('settingsUpdates.download')}
              </Button>
            ) : null}
            {hasUpdate && status?.downloaded ? (
              <Button variant="primary" onClick={() => void install()}>
                {t('settingsUpdates.installRestart')}
              </Button>
            ) : null}
            <KebabMenu
              label={t('common.moreActions')}
              disabled={checking}
              items={[
                {
                  label: checking
                    ? t('settingsUpdates.checking')
                    : t('settingsUpdates.refresh'),
                  onSelect: () => void checkNow(),
                  disabled: checking,
                },
              ]}
            />
          </>
        }
      />

      <SettingsCard>
        {hasUpdate ? (
          <>
            <div className="font-semibold text-gray-50">
              {t('settingsUpdates.available')}
            </div>
            <div className="mt-1 text-[13px] text-gray-400">
              {t('settingsUpdates.version', {
                version: status?.updateInfo?.version,
              })}
            </div>
            {status?.updateInfo?.releaseNotes && (
              <details className="mt-3 text-[12px] text-gray-400">
                <summary className="cursor-pointer">
                  {t('settingsUpdates.releaseNotes')}
                </summary>
                <div className="mt-2 whitespace-pre-wrap">
                  {String(status.updateInfo.releaseNotes)}
                </div>
              </details>
            )}
          </>
        ) : (
          <div className="text-[13px] text-gray-400">
            {t('settingsUpdates.none')}
          </div>
        )}

        {downloadProgress !== null && (
          <div className="mt-4">
            <div className="mb-1 text-[12px] text-gray-500">
              {t('settingsUpdates.downloading', {
                percent: Math.round(downloadProgress),
              })}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-700">
              <div
                className="h-1.5 rounded-full bg-blue-400 transition-all duration-300"
                style={{
                  width: `${Math.max(0, Math.min(100, downloadProgress))}%`,
                }}
              />
            </div>
          </div>
        )}

        {lastCheckedAt && (
          <div className="mt-3 text-[12px] text-gray-500">
            {t('common.lastChecked', {
              time: new Date(lastCheckedAt).toLocaleString(),
            })}
          </div>
        )}
      </SettingsCard>

      {error ? (
        <div className="mt-3">
          <SettingsStatus tone="error">{error}</SettingsStatus>
        </div>
      ) : null}
    </div>
  );
}

function BillingSettings() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setErr(null);
    setLoading(true);
    try {
      const s = await (window.api.license?.getStatus?.() ??
        window.api.billing.getStatus());
      setStatus(s);
    } catch (e: any) {
      setErr(String(e?.message || t('settingsBilling.loadFailed')));
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const licensed = Boolean(status?.licensed) || status?.required === false;
  const st = String(
    status?.status || (licensed ? 'ACTIVE' : 'PAUSED'),
  ).toUpperCase();
  const periodEnd = status?.currentPeriodEnd
    ? new Date(status.currentPeriodEnd).toLocaleString()
    : null;
  const email = String(status?.email || '');
  const key = String(status?.key || '');

  async function openUrl(url?: string | null) {
    const u = String(url || '').trim();
    if (!u) return;
    await window.api.system
      ?.openExternal?.(u)
      .catch(() => window.open(u, '_blank', 'noopener,noreferrer'));
  }

  async function manageBilling() {
    setBusy(true);
    setErr(null);
    try {
      const r = await (window.api.license?.createPortalSession?.() ??
        window.api.billing.createPortalSession?.());
      if (r?.error) {
        setErr(String(r.error));
        return;
      }
      await openUrl(r?.url);
    } catch (e: any) {
      setErr(String(e?.message || t('settingsBilling.portalFailed')));
    } finally {
      setBusy(false);
    }
  }

  async function copyKey() {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
    } catch {
      // ignore
    }
  }

  return (
    <div>
      <SettingsHeader
        title={t('settingsBilling.title')}
        description={t('settingsBilling.help')}
        actions={
          <>
            <Button
              variant="primary"
              onClick={() => void manageBilling()}
              disabled={busy || !key}
              loading={busy}
            >
              {t('settingsBilling.manage')}
            </Button>
            <KebabMenu
              label={t('common.moreActions')}
              items={[
                {
                  label: t('settingsBilling.refresh'),
                  onSelect: () => void refresh(),
                },
                {
                  label: t('settingsBilling.copy'),
                  onSelect: () => void copyKey(),
                  hidden: !key,
                },
              ]}
            />
          </>
        }
      />

      {loading ? (
        <SettingsStatus>{t('common.loading')}</SettingsStatus>
      ) : (
        <SettingsCard>
          {!status?.required && !status?.billingConfigured ? (
            <div className="text-[13px] text-gray-400">
              {t('settingsBilling.notRequired')}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  tone={
                    st === 'ACTIVE'
                      ? 'accent'
                      : st === 'PAST_DUE'
                        ? 'warn'
                        : 'danger'
                  }
                  dot
                >
                  {st === 'ACTIVE'
                    ? t('settingsBilling.active')
                    : st === 'PAST_DUE'
                      ? t('settingsBilling.paymentRequired')
                      : t('settingsBilling.paused')}
                </Badge>
                {periodEnd && (
                  <span className="text-[12px] text-gray-500">
                    {t('settingsBilling.periodEnds', { when: periodEnd })}
                  </span>
                )}
              </div>
              {email && (
                <div className="text-[13px]">
                  <span className="text-gray-500">
                    {t('settingsBilling.email')}
                  </span>
                  {email}
                </div>
              )}
              {key && (
                <div>
                  <div className="mb-1 text-[12px] text-gray-500">
                    {t('settingsBilling.licenseKey')}
                  </div>
                  <code className="block break-all rounded-md bg-black/30 px-2.5 py-2 text-[12px]">
                    {key}
                  </code>
                </div>
              )}
            </div>
          )}
        </SettingsCard>
      )}

      {err ? (
        <div className="mt-3">
          <SettingsStatus tone="error">{err}</SettingsStatus>
        </div>
      ) : null}
      {status?.message ? (
        <div className="mt-2">
          <SettingsStatus>{String(status.message)}</SettingsStatus>
        </div>
      ) : null}
    </div>
  );
}

function PreferencesSettings() {
  const [loading, setLoading] = useState(true);
  const [currency, setCurrency] = useState<string>('EUR');
  const [language, setLanguage] = useState<'en' | 'sq'>('en');
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<'PERCENT' | 'AMOUNT'>('PERCENT');
  const [value, setValue] = useState<string>('10');
  const [requireMgrDiscount, setRequireMgrDiscount] = useState(true);
  const [requireMgrVoid, setRequireMgrVoid] = useState(true);
  const [requireMgrServiceRemoval, setRequireMgrServiceRemoval] =
    useState(true);
  const [autoCloseShiftEnabled, setAutoCloseShiftEnabled] = useState(false);
  const [autoCloseShiftHours, setAutoCloseShiftHours] = useState<12 | 24>(12);
  const [reservationNoShowEnabled, setReservationNoShowEnabled] =
    useState(false);
  const [reservationNoShowMinutes, setReservationNoShowMinutes] =
    useState<number>(20);
  const [status, setStatus] = useState<string | null>(null);
  const { t } = useTranslation();

  type PrefDraft = {
    currency: string;
    language: 'en' | 'sq';
    enabled: boolean;
    mode: 'PERCENT' | 'AMOUNT';
    value: string;
    requireMgrDiscount: boolean;
    requireMgrVoid: boolean;
    requireMgrServiceRemoval: boolean;
    autoCloseShiftEnabled: boolean;
    autoCloseShiftHours: 12 | 24;
    reservationNoShowEnabled: boolean;
    reservationNoShowMinutes: number;
  };

  async function persist(patch: Partial<PrefDraft> = {}) {
    const next: PrefDraft = {
      currency,
      language,
      enabled,
      mode,
      value,
      requireMgrDiscount,
      requireMgrVoid,
      requireMgrServiceRemoval,
      autoCloseShiftEnabled,
      autoCloseShiftHours,
      reservationNoShowEnabled,
      reservationNoShowMinutes,
      ...patch,
    };
    setStatus(null);
    const cur = String(next.currency || '')
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) {
      setStatus(t('preferences.currencyInvalid'));
      return;
    }
    const n = Number(String(next.value).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) {
      setStatus(t('preferences.invalidAmount'));
      return;
    }
    const noShowMins = Math.max(
      5,
      Math.min(240, Math.round(Number(next.reservationNoShowMinutes) || 0)),
    );
    if (
      next.reservationNoShowEnabled &&
      (!Number.isFinite(noShowMins) || noShowMins < 5)
    ) {
      setStatus(t('preferences.noShowGrace'));
      return;
    }
    try {
      await window.api.settings.update({
        currency: cur,
        security: {
          approvals: {
            requireManagerPinForDiscount: next.requireMgrDiscount,
            requireManagerPinForVoid: next.requireMgrVoid,
            requireManagerPinForServiceChargeRemoval:
              next.requireMgrServiceRemoval,
          },
        },
        preferences: {
          language: next.language,
          serviceCharge: { enabled: next.enabled, mode: next.mode, value: n },
          autoCloseShift: {
            enabled: next.autoCloseShiftEnabled,
            hours: next.autoCloseShiftHours,
          },
          reservationAutoNoShow: {
            enabled: next.reservationNoShowEnabled,
            minutes: noShowMins,
          },
        },
      } as any);
      try {
        document.documentElement.lang = next.language === 'sq' ? 'sq' : 'en';
      } catch {
        // ignore
      }
      try {
        window.dispatchEvent(
          new CustomEvent('pos:localeChanged', {
            detail: { lng: next.language },
          }),
        );
      } catch {
        // ignore non-browser
      }
      setStatus(t('preferences.saved'));
    } catch (e: any) {
      setStatus(String(e?.message || t('preferences.saveFailed')));
    }
  }

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const s: any = await window.api.settings.get().catch(() => null);
        const cur =
          String((s as any)?.currency || 'EUR')
            .trim()
            .toUpperCase() || 'EUR';
        setCurrency(cur);
        const lang = String(
          (s as any)?.preferences?.language || 'en',
        ).toLowerCase();
        setLanguage(lang === 'sq' ? 'sq' : 'en');
        try {
          document.documentElement.lang = lang === 'sq' ? 'sq' : 'en';
        } catch {
          // ignore non-browser
        }
        const sc = (s as any)?.preferences?.serviceCharge || {};
        setEnabled(Boolean(sc.enabled));
        const m = String(sc.mode || 'PERCENT').toUpperCase();
        setMode(m === 'AMOUNT' ? 'AMOUNT' : 'PERCENT');
        setValue(sc.value != null ? String(sc.value) : '10');
        const approvals = (s as any)?.security?.approvals || {};
        setRequireMgrDiscount(approvals.requireManagerPinForDiscount !== false);
        setRequireMgrVoid(approvals.requireManagerPinForVoid !== false);
        setRequireMgrServiceRemoval(
          approvals.requireManagerPinForServiceChargeRemoval !== false,
        );
        const acs = (s as any)?.preferences?.autoCloseShift || {};
        setAutoCloseShiftEnabled(Boolean(acs.enabled));
        const h = Number(acs.hours);
        setAutoCloseShiftHours(h === 24 ? 24 : 12);
        const rns = (s as any)?.preferences?.reservationAutoNoShow || {};
        setReservationNoShowEnabled(Boolean(rns.enabled));
        const noShowMin = Number(rns.minutes);
        // Stored value is clamped to a safe range on save, but be defensive here.
        setReservationNoShowMinutes(
          Number.isFinite(noShowMin) && noShowMin >= 5 && noShowMin <= 240
            ? Math.round(noShowMin)
            : 20,
        );
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div>
      <SettingsHeader
        title={t('preferences.title')}
        actions={
          <Button
            variant="primary"
            onClick={() => void persist()}
            disabled={loading}
          >
            {t('preferences.savePreferences')}
          </Button>
        }
      />
      {loading ? (
        <SettingsStatus>{t('common.loading')}</SettingsStatus>
      ) : (
        <div className="space-y-3">
          <SettingsCard
            title={t('preferences.currency')}
            description={t('preferences.currencyHelp')}
          >
            <Select
              className="max-w-[180px]"
              value={currency}
              onChange={(e) => {
                const next = String(e.target.value || '').toUpperCase();
                setCurrency(next);
                void persist({ currency: next });
              }}
            >
              <option value="EUR">EUR</option>
              <option value="QAR">QAR</option>
              <option value="USD">USD</option>
              <option value="GBP">GBP</option>
              <option value="AED">AED</option>
              <option value="ALL">ALL</option>
            </Select>
          </SettingsCard>

          <SettingsCard
            title={t('preferences.languages')}
            description={t('preferences.languagesHelp')}
          >
            <Select
              className="max-w-xs"
              value={language}
              onChange={(e) => {
                const next = e.target.value === 'sq' ? 'sq' : 'en';
                setLanguage(next);
                void persist({ language: next });
              }}
              aria-label={t('preferences.languages')}
            >
              <option value="en">{t('preferences.langEnglish')}</option>
              <option value="sq">{t('preferences.langAlbanian')}</option>
            </Select>
          </SettingsCard>

          <SettingsCard
            title={t('preferences.approvalsTitle')}
            description={t('preferences.approvalsHelp')}
          >
            <div className="space-y-4">
              <SettingsToggleRow
                title={t('preferences.requirePinDiscount')}
                description={t('preferences.requirePinDiscountHelp')}
                checked={requireMgrDiscount}
                onChange={(next) => {
                  setRequireMgrDiscount(next);
                  void persist({ requireMgrDiscount: next });
                }}
                label={t('preferences.requirePinDiscount')}
              />
              <SettingsToggleRow
                title={t('preferences.requirePinVoids')}
                description={t('preferences.requirePinVoidsHelp')}
                checked={requireMgrVoid}
                onChange={(next) => {
                  setRequireMgrVoid(next);
                  void persist({ requireMgrVoid: next });
                }}
                label={t('preferences.requirePinVoids')}
              />
              <SettingsToggleRow
                title={t('preferences.requirePinService')}
                description={t('preferences.requirePinServiceHelp')}
                checked={requireMgrServiceRemoval}
                onChange={(next) => {
                  setRequireMgrServiceRemoval(next);
                  void persist({ requireMgrServiceRemoval: next });
                }}
                label={t('preferences.requirePinService')}
              />
            </div>
          </SettingsCard>

          <SettingsCard
            title={t('preferences.autoCloseTitle')}
            description={t('preferences.autoCloseHelp')}
          >
            <div className="space-y-3">
              <SettingsToggleRow
                title={t('preferences.autoCloseEnable')}
                description={t('preferences.autoCloseEnableHelp')}
                checked={autoCloseShiftEnabled}
                onChange={(next) => {
                  setAutoCloseShiftEnabled(next);
                  void persist({ autoCloseShiftEnabled: next });
                }}
                label={t('preferences.autoCloseEnable')}
              />
              <Segmented
                block
                value={autoCloseShiftHours}
                onChange={(next) => {
                  setAutoCloseShiftHours(next);
                  void persist({ autoCloseShiftHours: next });
                }}
                ariaLabel={t('preferences.autoCloseTitle')}
                options={[
                  {
                    value: 12,
                    label: t('preferences.hours12'),
                    disabled: !autoCloseShiftEnabled,
                  },
                  {
                    value: 24,
                    label: t('preferences.hours24'),
                    disabled: !autoCloseShiftEnabled,
                  },
                ]}
              />
            </div>
          </SettingsCard>

          <SettingsCard
            title={t('preferences.autoNoShowTitle')}
            description={t('preferences.autoNoShowHelp')}
          >
            <div className="space-y-3">
              <SettingsToggleRow
                title={t('preferences.autoNoShowEnable')}
                description={t('preferences.autoNoShowEnableHelp')}
                checked={reservationNoShowEnabled}
                onChange={(next) => {
                  setReservationNoShowEnabled(next);
                  void persist({ reservationNoShowEnabled: next });
                }}
                label={t('preferences.autoNoShowEnable')}
              />
              <Segmented
                block
                value={reservationNoShowMinutes}
                onChange={(next) => {
                  setReservationNoShowMinutes(next);
                  void persist({ reservationNoShowMinutes: next });
                }}
                ariaLabel={t('preferences.autoNoShowTitle')}
                options={[10, 15, 20, 30, 45, 60].map((p) => ({
                  value: p,
                  label: t('preferences.minutesShort', { count: p }),
                  disabled: !reservationNoShowEnabled,
                }))}
              />
              <Field
                label={t('preferences.customGrace')}
                hint={t('preferences.graceRange')}
              >
                <Input
                  type="number"
                  min={5}
                  max={240}
                  step={5}
                  className="max-w-[120px]"
                  disabled={!reservationNoShowEnabled}
                  value={reservationNoShowMinutes}
                  onChange={(e) => {
                    const next = Math.max(
                      5,
                      Math.min(240, Number(e.target.value) || 0),
                    );
                    setReservationNoShowMinutes(next);
                  }}
                  onBlur={() =>
                    void persist({
                      reservationNoShowMinutes,
                    })
                  }
                />
              </Field>
            </div>
          </SettingsCard>

          <SettingsCard
            title={t('preferences.serviceChargeTitle')}
            description={t('preferences.serviceChargeHelp')}
          >
            <div className="space-y-3">
              <SettingsToggleRow
                title={t('preferences.serviceChargeEnable')}
                checked={enabled}
                onChange={(next) => {
                  setEnabled(next);
                  void persist({ enabled: next });
                }}
                label={t('preferences.serviceChargeEnable')}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  value={mode}
                  onChange={(next) => {
                    setMode(next);
                    void persist({ mode: next });
                  }}
                  ariaLabel={t('preferences.serviceChargeTitle')}
                  options={[
                    {
                      value: 'PERCENT',
                      label: '%',
                      disabled: !enabled,
                    },
                    {
                      value: 'AMOUNT',
                      label: t('preferences.fixedAmount'),
                      disabled: !enabled,
                    },
                  ]}
                />
                <Input
                  className="max-w-[140px]"
                  disabled={!enabled}
                  placeholder={
                    mode === 'PERCENT'
                      ? t('order.discountPlaceholderPercent')
                      : t('order.discountPlaceholderAmount')
                  }
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onBlur={() => void persist({ value })}
                />
              </div>
            </div>
          </SettingsCard>

          {status ? <SettingsStatus tone="ok">{status}</SettingsStatus> : null}
        </div>
      )}
    </div>
  );
}

function FiscalSettings() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<'easypos'>('easypos');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:8080');
  const [authToken, setAuthToken] = useState('');
  const [authTokenConfigured, setAuthTokenConfigured] = useState(false);
  const [integrationApp, setIntegrationApp] = useState('');
  const [defaultOperatorId, setDefaultOperatorId] = useState('');
  const [defaultSoldIn, setDefaultSoldIn] = useState('XPP');
  const [cloudFallbackArticleId, setCloudFallbackArticleId] = useState('');
  const [eurExchangeRate, setEurExchangeRate] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [statusOk, setStatusOk] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);
  const [testingMinimal, setTestingMinimal] = useState(false);
  const [tokenHint, setTokenHint] = useState<{
    configured: boolean;
    suffix?: string;
    tokenId?: string;
    deviceTail?: string;
  } | null>(null);
  const { t } = useTranslation();

  async function refreshTokenHint() {
    const hint = await window.api.settings
      .getFiscalTokenHint?.()
      .catch(() => null);
    if (hint) setTokenHint(hint);
  }

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const s: any = await window.api.settings.get().catch(() => null);
        const fiscal = (s as any)?.fiscal || {};
        setEnabled(Boolean(fiscal.enabled));
        setProvider(fiscal.provider === 'easypos' ? 'easypos' : 'easypos');
        setBaseUrl(String(fiscal.baseUrl || 'http://127.0.0.1:8080').trim());
        setAuthTokenConfigured(Boolean(fiscal.authTokenConfigured));
        setAuthToken('');
        setDefaultOperatorId(
          String(fiscal.defaultOperatorId || '').trim() === 'gh537ez200'
            ? 'gh537ez280'
            : String(fiscal.defaultOperatorId || '').trim(),
        );
        setIntegrationApp(String(fiscal.integrationApp || '').trim());
        setDefaultSoldIn(String(fiscal.defaultSoldIn || 'XPP').trim() || 'XPP');
        setCloudFallbackArticleId(
          String(fiscal.cloudFallbackArticleId || '').trim(),
        );
        setEurExchangeRate(
          fiscal.eurExchangeRate != null &&
            Number.isFinite(Number(fiscal.eurExchangeRate))
            ? String(fiscal.eurExchangeRate)
            : '',
        );
      } finally {
        setLoading(false);
      }
      await refreshTokenHint();
    })();
  }, []);

  async function save() {
    setStatus(null);
    setStatusOk(null);
    const url = String(baseUrl || '')
      .trim()
      .replace(/\/+$/g, '');
    const cloud = /api\.(dev\.)?easypos\.al/i.test(url);
    if (enabled && !url) {
      setStatusOk(false);
      setStatus(t('fiscal.baseUrlRequired'));
      return;
    }
    if (enabled && !authToken && !authTokenConfigured) {
      setStatusOk(false);
      setStatus(t('fiscal.authTokenRequired'));
      return;
    }
    if (enabled && cloud && !String(integrationApp || '').trim()) {
      setStatusOk(false);
      setStatus(t('fiscal.integrationAppRequired'));
      return;
    }
    if (enabled && cloud && !String(defaultOperatorId || '').trim()) {
      setStatusOk(false);
      setStatus(t('fiscal.operatorIdRequired'));
      return;
    }
    const op = String(defaultOperatorId || '').trim();
    if (enabled && cloud && op === 'gh537ez200') {
      setStatusOk(false);
      setStatus(t('fiscal.operatorIdTypo'));
      return;
    }
    await window.api.settings.update({
      fiscal: {
        enabled,
        provider,
        baseUrl: url || 'http://127.0.0.1:8080',
        ...(authToken.trim() ? { authToken: authToken.trim() } : {}),
        integrationApp: String(integrationApp || '').trim() || undefined,
        defaultOperatorId: String(defaultOperatorId || '').trim() || undefined,
        defaultSoldIn: String(defaultSoldIn || '').trim() || 'XPP',
        cloudFallbackArticleId:
          String(cloudFallbackArticleId || '').trim() || undefined,
        ...(String(eurExchangeRate || '').trim()
          ? {
              eurExchangeRate: Number(
                String(eurExchangeRate).replace(',', '.'),
              ),
            }
          : {}),
      },
    } as any);
    const latest: any = await window.api.settings.get().catch(() => null);
    setAuthTokenConfigured(Boolean(latest?.fiscal?.authTokenConfigured));
    setAuthToken('');
    setStatusOk(true);
    setStatus(t('fiscal.saved'));
    try {
      window.dispatchEvent(new CustomEvent('pos:settingsChanged'));
    } catch {
      // ignore
    }
    await refreshTokenHint();
  }

  async function testMinimalInvoice() {
    setTestingMinimal(true);
    setStatus(null);
    setStatusOk(null);
    try {
      if (!window.api.settings.testFiscalMinimalInvoice) {
        setStatusOk(false);
        setStatus(t('fiscal.testMinimalUnavailable'));
        return;
      }
      if (authToken.trim()) {
        await window.api.settings.update({
          fiscal: {
            enabled: true,
            provider,
            baseUrl: String(baseUrl || '')
              .trim()
              .replace(/\/+$/g, ''),
            authToken: authToken.trim(),
            integrationApp: String(integrationApp || '').trim() || undefined,
            defaultOperatorId:
              String(defaultOperatorId || '').trim() || undefined,
            defaultSoldIn: String(defaultSoldIn || '').trim() || 'XPP',
            cloudFallbackArticleId:
              String(cloudFallbackArticleId || '').trim() || undefined,
            ...(String(eurExchangeRate || '').trim()
              ? {
                  eurExchangeRate: Number(
                    String(eurExchangeRate).replace(',', '.'),
                  ),
                }
              : {}),
          },
        } as any);
        setAuthTokenConfigured(true);
        setAuthToken('');
        setEnabled(true);
        await refreshTokenHint();
      }
      const r = await window.api.settings.testFiscalMinimalInvoice?.();
      if (r?.ok) {
        setStatusOk(true);
        setStatus(r.message || t('fiscal.testMinimalOk'));
      } else {
        setStatusOk(false);
        setStatus(r?.message || t('fiscal.testMinimalFailed'));
      }
    } catch (e: any) {
      setStatusOk(false);
      setStatus(String(e?.message || t('fiscal.testMinimalFailed')));
    } finally {
      setTestingMinimal(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setStatus(null);
    setStatusOk(null);
    try {
      if (authToken.trim()) {
        await window.api.settings.update({
          fiscal: {
            enabled: true,
            provider,
            baseUrl: String(baseUrl || '')
              .trim()
              .replace(/\/+$/g, ''),
            authToken: authToken.trim(),
            integrationApp: String(integrationApp || '').trim() || undefined,
            defaultOperatorId:
              String(defaultOperatorId || '').trim() || undefined,
            defaultSoldIn: String(defaultSoldIn || '').trim() || 'XPP',
            cloudFallbackArticleId:
              String(cloudFallbackArticleId || '').trim() || undefined,
            ...(String(eurExchangeRate || '').trim()
              ? {
                  eurExchangeRate: Number(
                    String(eurExchangeRate).replace(',', '.'),
                  ),
                }
              : {}),
          },
        } as any);
        setAuthTokenConfigured(true);
        setAuthToken('');
        setEnabled(true);
      } else if (!enabled) {
        await window.api.settings.update({
          fiscal: {
            enabled: true,
            provider,
            baseUrl: String(baseUrl || '')
              .trim()
              .replace(/\/+$/g, ''),
            integrationApp: String(integrationApp || '').trim() || undefined,
            defaultOperatorId:
              String(defaultOperatorId || '').trim() || undefined,
            defaultSoldIn: String(defaultSoldIn || '').trim() || 'XPP',
            cloudFallbackArticleId:
              String(cloudFallbackArticleId || '').trim() || undefined,
            ...(String(eurExchangeRate || '').trim()
              ? {
                  eurExchangeRate: Number(
                    String(eurExchangeRate).replace(',', '.'),
                  ),
                }
              : {}),
          },
        } as any);
        setEnabled(true);
      }
      const r = await window.api.settings.testFiscalConnection?.();
      if (r?.ok) {
        setStatusOk(true);
        const key = r.messageKey ? `fiscal.${r.messageKey}` : null;
        setStatus(
          key && key.startsWith('fiscal.')
            ? t(key as any)
            : r.message || t('fiscal.testOk'),
        );
      } else {
        setStatusOk(false);
        setStatus(r?.message || t('fiscal.testFailed'));
      }
    } catch (e: any) {
      setStatusOk(false);
      setStatus(String(e?.message || t('fiscal.testFailed')));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div>
      <SettingsHeader
        title={t('fiscal.title')}
        actions={
          <>
            <Button variant="primary" onClick={() => void save()}>
              {t('fiscal.save')}
            </Button>
            <KebabMenu
              label={t('common.moreActions')}
              items={[
                {
                  label: testing
                    ? t('fiscal.testing')
                    : t('fiscal.testConnection'),
                  onSelect: () => void testConnection(),
                  disabled: !enabled || testing || testingMinimal,
                },
                {
                  label: testingMinimal
                    ? t('fiscal.testingMinimal')
                    : t('fiscal.testMinimalInvoice'),
                  onSelect: () => void testMinimalInvoice(),
                  disabled: !enabled || testing || testingMinimal,
                },
              ]}
            />
          </>
        }
      />
      {/* Unresolved sales come first — they are money waiting on a decision. */}
      <FiscalReviewPanel />
      {loading ? (
        <div className="opacity-70">{t('common.loading')}</div>
      ) : (
        <div className="space-y-4">
          <SettingsCard
            title={t('fiscal.enableTitle')}
            description={t('fiscal.enableHelp')}
          >
            <SettingsToggleRow
              title={t('fiscal.enableLabel')}
              checked={enabled}
              onChange={setEnabled}
              label={t('fiscal.enableLabel')}
            />
          </SettingsCard>

          <SettingsCard
            title={t('fiscal.middlewareTitle')}
            description={t('fiscal.middlewareHelp')}
          >
            <div className="space-y-3">
              <label className="block">
                <div className="text-sm mb-1">{t('fiscal.provider')}</div>
                <select
                  className="bg-gray-700 rounded px-3 py-2 w-full max-w-xs"
                  value={provider}
                  onChange={(e) =>
                    setProvider(
                      e.target.value === 'easypos' ? 'easypos' : 'easypos',
                    )
                  }
                  disabled={!enabled}
                >
                  <option value="easypos">easyPos</option>
                </select>
              </label>

              <label className="block">
                <div className="text-sm mb-1">{t('fiscal.baseUrl')}</div>
                <input
                  className="bg-gray-700 rounded px-3 py-2 w-full"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.dev.easypos.al/fiscalisation-service/v1"
                  disabled={!enabled}
                />
                <div className="text-[11px] opacity-60 mt-1">
                  {t('fiscal.baseUrlHelp')}
                </div>
              </label>

              <label className="block">
                <div className="text-sm mb-1">{t('fiscal.authToken')}</div>
                <input
                  className="bg-gray-700 rounded px-3 py-2 w-full"
                  type="password"
                  value={authToken}
                  onChange={(e) => setAuthToken(e.target.value)}
                  placeholder={
                    authTokenConfigured
                      ? t('fiscal.authTokenConfigured')
                      : t('fiscal.authTokenPlaceholder')
                  }
                  disabled={!enabled}
                />
                {authTokenConfigured && !authToken.trim() ? (
                  <div className="text-xs text-emerald-400 mt-1">
                    {t('fiscal.authTokenStored')}
                  </div>
                ) : null}
                {tokenHint?.configured ? (
                  <div className="text-xs opacity-70 mt-1">
                    {t('fiscal.tokenHint', {
                      suffix: tokenHint.suffix || '—',
                      tokenId: tokenHint.tokenId || '—',
                      deviceTail: tokenHint.deviceTail || '—',
                    })}
                  </div>
                ) : null}
                <div className="text-[11px] opacity-60 mt-1">
                  {t('fiscal.tokenResyncHelp')}
                </div>
              </label>

              <label className="block">
                <div className="text-sm mb-1">{t('fiscal.integrationApp')}</div>
                <input
                  className="bg-gray-700 rounded px-3 py-2 w-full"
                  value={integrationApp}
                  onChange={(e) => setIntegrationApp(e.target.value)}
                  placeholder={t('fiscal.integrationAppPlaceholder')}
                  disabled={!enabled}
                />
              </label>

              <label className="block">
                <div className="text-sm mb-1">{t('fiscal.operatorId')}</div>
                <input
                  className="bg-gray-700 rounded px-3 py-2 w-full max-w-xs"
                  value={defaultOperatorId}
                  onChange={(e) => setDefaultOperatorId(e.target.value)}
                  placeholder={t('fiscal.operatorIdPlaceholder')}
                  disabled={!enabled}
                />
                <div className="text-[11px] opacity-60 mt-1">
                  {t('fiscal.operatorIdHelp')}
                </div>
              </label>

              <label className="block">
                <div className="text-sm mb-1">{t('fiscal.defaultSoldIn')}</div>
                <input
                  className="bg-gray-700 rounded px-3 py-2 w-full max-w-xs"
                  value={defaultSoldIn}
                  onChange={(e) => setDefaultSoldIn(e.target.value)}
                  placeholder="XPP"
                  disabled={!enabled}
                />
                <div className="text-[11px] opacity-60 mt-1">
                  {t('fiscal.defaultSoldInHelp')}
                </div>
              </label>

              <label className="block">
                <div className="text-sm mb-1">
                  {t('fiscal.cloudFallbackArticleId')}
                </div>
                <input
                  className="bg-gray-700 rounded px-3 py-2 w-full max-w-xs"
                  value={cloudFallbackArticleId}
                  onChange={(e) => setCloudFallbackArticleId(e.target.value)}
                  placeholder="PROD001"
                  disabled={!enabled}
                />
                <div className="text-[11px] opacity-60 mt-1">
                  {t('fiscal.cloudFallbackArticleIdHelp')}
                </div>
              </label>

              <label className="block">
                <div className="text-sm mb-1">
                  {t('fiscal.eurExchangeRate')}
                </div>
                <input
                  className="bg-gray-700 rounded px-3 py-2 w-full max-w-xs"
                  value={eurExchangeRate}
                  onChange={(e) => setEurExchangeRate(e.target.value)}
                  placeholder="100.5"
                  disabled={!enabled}
                />
                <div className="text-[11px] opacity-60 mt-1">
                  {t('fiscal.eurExchangeRateHelp')}
                </div>
              </label>
            </div>
          </SettingsCard>

          {status ? (
            <SettingsStatus
              tone={
                statusOk === false
                  ? 'error'
                  : statusOk === true
                    ? 'ok'
                    : 'muted'
              }
            >
              {status.replace(/ · /g, '\n')}
            </SettingsStatus>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Payments the POS refused to retry because it could not tell whether
 * easyPos had already registered the invoice.
 *
 * Only an admin looking at easyPos can settle these, so the panel asks
 * exactly one question — is the invoice there or not — and makes the
 * consequence of each answer explicit. Both answers are irreversible in
 * practice: "not there" sends the payment again, "there" records it as
 * done forever.
 */
function FiscalReviewPanel() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<FiscalReviewDTO[] | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [nslf, setNslf] = useState('');
  const [nivf, setNivf] = useState('');
  const [status, setStatus] = useState<string>('');

  const supported = Boolean(window.api.settings.listFiscalReviews);

  const load = useCallback(async () => {
    if (!supported) return;
    try {
      setRows((await window.api.settings.listFiscalReviews?.()) ?? []);
    } catch {
      setRows([]);
    }
  }, [supported]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (
    idempotencyKey: string,
    resolution: 'retry' | 'registered' | 'corrected',
  ) => {
    setBusyKey(idempotencyKey);
    setStatus('');
    try {
      const r = await window.api.settings.resolveFiscalReview?.({
        idempotencyKey,
        resolution,
        ...(resolution === 'registered'
          ? { nslf: nslf.trim(), nivf: nivf.trim() }
          : {}),
      });
      setStatus(r?.ok ? t('fiscal.reviewResolved') : t('fiscal.reviewFailed'));
      setExpanded(null);
      setNslf('');
      setNivf('');
      await load();
    } catch (e: any) {
      setStatus(String(e?.message || t('fiscal.reviewFailed')));
    } finally {
      setBusyKey(null);
    }
  };

  // Stay out of the way entirely when there is nothing to reconcile.
  if (!supported || !rows || rows.length === 0) return null;

  return (
    <div className="mb-4 rounded border border-amber-600/60 bg-amber-950/30 p-3">
      <div className="font-medium text-amber-300">
        {t('fiscal.reviewTitle')} ({rows.length})
      </div>
      <div className="text-[11px] opacity-80 mt-1 mb-3">
        {t('fiscal.reviewHelp')}
      </div>

      <div className="flex flex-col gap-2">
        {rows.map((row) => {
          const open = expanded === row.idempotencyKey;
          const busy = busyKey === row.idempotencyKey;
          return (
            <div
              key={row.idempotencyKey}
              className="rounded bg-gray-900/60 p-2 text-xs"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-medium">
                  {[row.area, row.tableLabel && `Table ${row.tableLabel}`]
                    .filter(Boolean)
                    .join(' ') || '—'}
                </span>
                <span className="rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                  {row.kind === 'correction-required'
                    ? t('fiscal.reviewKindCorrection')
                    : t('fiscal.reviewKindUnknown')}
                </span>
                {row.total != null ? <span>{row.total.toFixed(2)}</span> : null}
                <span className="opacity-60">
                  {new Date(row.updatedAt).toLocaleString()}
                </span>
                <span className="opacity-60">
                  {t('fiscal.reviewAttempts', { count: row.attempts })}
                </span>
              </div>
              <div className="mt-1 font-mono break-all opacity-80">
                {t('fiscal.reviewDocId')}: {row.idempotencyKey}
              </div>
              {row.nivf || row.nslf ? (
                <div className="mt-1 font-mono break-all opacity-80">
                  {[
                    row.nivf && `${t('fiscal.reviewNivf')}: ${row.nivf}`,
                    row.nslf && `${t('fiscal.reviewNslf')}: ${row.nslf}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              ) : null}
              {row.lastError ? (
                <div className="mt-1 opacity-70 break-words">
                  {row.lastError}
                </div>
              ) : null}

              {/* A correction has one honest answer: file it in easyPos,
                  then say so. Retrying or re-recording makes no sense. */}
              {row.kind === 'correction-required' ? (
                <div className="mt-2 flex flex-col gap-2 border-t border-gray-700 pt-2">
                  <div className="opacity-80">
                    {t('fiscal.reviewCorrectionHelp')}
                  </div>
                  <div>
                    <button
                      type="button"
                      disabled={busy}
                      className="px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50"
                      onClick={() =>
                        void resolve(row.idempotencyKey, 'corrected')
                      }
                    >
                      {t('fiscal.reviewConfirmCorrected')}
                    </button>
                  </div>
                </div>
              ) : open ? (
                <div className="mt-2 flex flex-col gap-2 border-t border-gray-700 pt-2">
                  <div className="opacity-80">
                    {t('fiscal.reviewFoundHelp')}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <label className="flex-1 min-w-[140px]">
                      <div className="mb-1">{t('fiscal.reviewNslf')}</div>
                      <input
                        className="w-full bg-gray-800 rounded px-2 py-1"
                        value={nslf}
                        onChange={(e) => setNslf(e.target.value)}
                      />
                    </label>
                    <label className="flex-1 min-w-[140px]">
                      <div className="mb-1">{t('fiscal.reviewNivf')}</div>
                      <input
                        className="w-full bg-gray-800 rounded px-2 py-1"
                        value={nivf}
                        onChange={(e) => setNivf(e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      className="px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50"
                      onClick={() =>
                        void resolve(row.idempotencyKey, 'registered')
                      }
                    >
                      {t('fiscal.reviewConfirmFound')}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
                      onClick={() => setExpanded(null)}
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
                    onClick={() => {
                      setExpanded(row.idempotencyKey);
                      setNslf('');
                      setNivf('');
                    }}
                  >
                    {t('fiscal.reviewFound')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
                    title={t('fiscal.reviewNotFoundHelp')}
                    onClick={() => void resolve(row.idempotencyKey, 'retry')}
                  >
                    {t('fiscal.reviewNotFound')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {status ? <div className="mt-2 text-xs opacity-80">{status}</div> : null}
    </div>
  );
}

function BackupsSettings() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<
    Array<{ name: string; bytes: number; createdAt: string }>
  >([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const list = await (window.api as any).backups.list();
      setRows(Array.isArray(list) ? list : []);
    } catch (e: any) {
      setStatus(e?.message || t('settingsBackups.failedLoad'));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function fmtBytes(n: number) {
    const b = Number(n || 0);
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  async function createBackup() {
    setBusy('create');
    setStatus(null);
    try {
      const r = await (window.api as any).backups.create();
      if (!r?.ok) setStatus(r?.error || t('settingsBackups.failed'));
      else setStatus(t('settingsBackups.created'));
      await reload();
    } catch (e: any) {
      setStatus(e?.message || t('settingsBackups.failed'));
    } finally {
      setBusy(null);
    }
  }

  async function restoreBackup(name: string) {
    const ok = confirm(t('settingsBackups.restoreConfirm', { name }));
    if (!ok) return;
    setBusy(`restore:${name}`);
    setStatus(null);
    try {
      const r = await (window.api as any).backups.restore({ name });
      if (!r?.ok) setStatus(r?.error || t('settingsBackups.restoreFailed'));
      else if (r?.devRestartRequired)
        setStatus(t('settingsBackups.restoredDev'));
      else setStatus(t('settingsBackups.restoring'));
    } catch (e: any) {
      setStatus(e?.message || t('settingsBackups.restoreFailed'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <SettingsHeader
        title={t('settingsBackups.title')}
        description={t('settingsBackups.help')}
        actions={
          <KebabMenu
            label={t('settingsBackups.actionsAria')}
            disabled={busy != null}
            items={[
              {
                label:
                  busy === 'create'
                    ? t('settingsBackups.creating')
                    : t('settingsBackups.backupNow'),
                onSelect: () => void createBackup(),
                disabled: busy != null,
              },
              {
                label: t('settingsBackups.refresh'),
                onSelect: () => void reload(),
                disabled: busy != null,
              },
            ]}
          />
        }
      />

      {status ? (
        <div className="mb-3">
          <SettingsStatus>{status}</SettingsStatus>
        </div>
      ) : null}

      {loading ? (
        <SettingsStatus>{t('common.loading')}</SettingsStatus>
      ) : rows.length === 0 ? (
        <SettingsCard>
          <div className="text-[13px] text-gray-400">
            {t('settingsBackups.empty')}
          </div>
        </SettingsCard>
      ) : (
        <SettingsCard padded={false}>
          <div className="divide-y divide-white/7">
            {rows.map((b) => (
              <div
                key={b.name}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium">
                    {b.name}
                  </div>
                  <div className="text-[12px] text-gray-500">
                    {new Date(b.createdAt).toLocaleString()} ·{' '}
                    {fmtBytes(b.bytes)}
                  </div>
                </div>
                <KebabMenu
                  label={t('common.moreActions')}
                  disabled={busy != null}
                  items={[
                    {
                      label: t('settingsBackups.restore'),
                      onSelect: () => void restoreBackup(b.name),
                      disabled: busy != null,
                      danger: true,
                    },
                  ]}
                />
              </div>
            ))}
          </div>
        </SettingsCard>
      )}
    </div>
  );
}

function GoogleCalendarSettings() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [oauthConfigured, setOauthConfigured] = useState(false);
  const [oauthConnected, setOauthConnected] = useState(false);
  const [accountEmail, setAccountEmail] = useState('');
  const [calendarId, setCalendarId] = useState('primary');
  const [calendarSummary, setCalendarSummary] = useState('');
  const [calendars, setCalendars] = useState<
    Array<{ id: string; summary: string; primary?: boolean }>
  >([]);
  const [syncIntervalMin, setSyncIntervalMin] = useState(5);
  const [defaultArea, setDefaultArea] = useState('');
  const [defaultDurationMin, setDefaultDurationMin] = useState(120);
  const [areas, setAreas] = useState<string[]>([]);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [lastSyncMessage, setLastSyncMessage] = useState<string | null>(null);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const loadSettings = async () => {
    const s: any = await window.api.settings.get();
    const gc = s?.googleCalendar || {};
    setEnabled(Boolean(gc.enabled));
    setOauthConfigured(Boolean(s?.googleCalendarOAuthConfigured));
    setOauthConnected(Boolean(gc.oauthConnected));
    setAccountEmail(String(gc.accountEmail || ''));
    setCalendarId(String(gc.calendarId || 'primary'));
    setCalendarSummary(String(gc.calendarSummary || ''));
    setSyncIntervalMin(Number(gc.syncIntervalMin || 5));
    setDefaultDurationMin(Number(gc.defaultDurationMin || 120));
    setLastSyncAt(gc.lastSyncAt ? String(gc.lastSyncAt) : null);
    setLastSyncMessage(gc.lastSyncMessage ? String(gc.lastSyncMessage) : null);
    setLastSyncError(gc.lastSyncError ? String(gc.lastSyncError) : null);
    const tableAreas = Array.isArray(s?.tableAreas)
      ? s.tableAreas
          .map((a: any) => String(a?.name || '').trim())
          .filter(Boolean)
      : [];
    setAreas(tableAreas);
    setDefaultArea((current) => {
      const saved = String(gc.defaultArea || current || '').trim();
      if (saved && tableAreas.includes(saved)) return saved;
      return tableAreas[0] || '';
    });
    if (gc.oauthConnected) {
      const listed = await window.api.settings.listGoogleCalendars?.();
      if (listed?.ok && Array.isArray(listed.calendars)) {
        setCalendars(listed.calendars);
      }
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!alive) return;
        await loadSettings();
      } catch {
        /* ignore */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const selected = calendars.find((c) => c.id === calendarId);
      const payload: any = {
        googleCalendar: {
          enabled,
          syncIntervalMin,
          defaultArea: defaultArea.trim() || areas[0] || '',
          defaultDurationMin,
          calendarId,
          calendarSummary: selected?.summary || calendarSummary || undefined,
        },
      };
      await window.api.settings.update(payload);
      setStatus(t('googleCalendar.saved'));
      toast.success(t('googleCalendar.saved'));
    } catch (e: any) {
      const msg = String(e?.message || t('googleCalendar.saveFailed'));
      setStatus(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const connect = async () => {
    setConnecting(true);
    setStatus(t('googleCalendar.connecting'));
    try {
      const result = await window.api.settings.connectGoogleCalendar?.();
      if (!result?.ok) {
        throw new Error(
          String(result?.error || t('googleCalendar.connectFailed')),
        );
      }
      setOauthConnected(true);
      setEnabled(true);
      setAccountEmail(String(result.accountEmail || ''));
      setCalendarId(String(result.calendarId || 'primary'));
      setCalendarSummary(String(result.calendarSummary || ''));
      if (Array.isArray(result.calendars)) setCalendars(result.calendars);
      if (result.warning) {
        setLastSyncError(result.warning);
        setStatus(result.warning);
        toast.error(result.warning);
        return;
      }
      setStatus(
        t('googleCalendar.connected', { email: result.accountEmail || '' }),
      );
      toast.success(
        t('googleCalendar.connected', { email: result.accountEmail || '' }),
      );
    } catch (e: any) {
      const msg = String(e?.message || t('googleCalendar.connectFailed'));
      setStatus(msg);
      toast.error(msg);
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    setConnecting(true);
    setStatus(null);
    try {
      await window.api.settings.disconnectGoogleCalendar?.();
      setOauthConnected(false);
      setAccountEmail('');
      setCalendarSummary('');
      setCalendars([]);
      setStatus(t('googleCalendar.disconnected'));
      toast.success(t('googleCalendar.disconnected'));
    } catch (e: any) {
      const msg = String(e?.message || t('googleCalendar.disconnectFailed'));
      setStatus(msg);
      toast.error(msg);
    } finally {
      setConnecting(false);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    setStatus(null);
    try {
      const result = await window.api.settings.syncGoogleCalendar?.();
      if (!result) throw new Error(t('googleCalendar.syncUnavailable'));
      const refreshed: any = await window.api.settings.get();
      const gc = refreshed?.googleCalendar || {};
      setLastSyncAt(gc.lastSyncAt ? String(gc.lastSyncAt) : null);
      setLastSyncMessage(
        gc.lastSyncMessage ? String(gc.lastSyncMessage) : null,
      );
      setLastSyncError(gc.lastSyncError ? String(gc.lastSyncError) : null);
      if (!result.ok) {
        const msg = String(result.error || t('googleCalendar.syncFailed'));
        setStatus(msg);
        toast.error(msg);
        return;
      }
      const msg = String(
        result.message ||
          t('googleCalendar.syncSuccess', {
            imported: result.imported,
            updated: result.updated,
            cancelled: result.cancelled,
          }),
      );
      setStatus(msg);
      toast.success(msg);
    } catch (e: any) {
      const msg = String(e?.message || t('googleCalendar.syncFailed'));
      setStatus(msg);
      toast.error(msg);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div>
      <SettingsHeader
        title={t('googleCalendar.title')}
        description={t('googleCalendar.subtitle')}
        actions={
          <>
            <Button
              variant="primary"
              onClick={() => void save()}
              disabled={loading || saving}
              loading={saving}
            >
              {saving ? t('common.saving') : t('common.save')}
            </Button>
            <KebabMenu
              label={t('common.moreActions')}
              items={[
                {
                  label: syncing
                    ? t('googleCalendar.syncing')
                    : t('googleCalendar.syncNow'),
                  onSelect: () => void syncNow(),
                  disabled: loading || syncing || !enabled || !oauthConnected,
                },
                {
                  label: t('googleCalendar.disconnect'),
                  onSelect: () => void disconnect(),
                  hidden: !oauthConnected,
                  disabled: loading || connecting,
                  danger: true,
                },
              ]}
            />
          </>
        }
      />

      <div className="space-y-3">
        <SettingsCard>
          <p className="whitespace-pre-line text-[12px] leading-relaxed text-gray-500">
            {t('googleCalendar.flowHelp')}
          </p>
        </SettingsCard>

        {!oauthConfigured && (
          <div className="rounded-lg border border-amber-700/40 bg-amber-950/20 px-4 py-3 text-[13px] text-amber-100">
            {t('googleCalendar.oauthNotConfigured')}
          </div>
        )}

        <SettingsCard title={t('googleCalendar.accountTitle')}>
          {oauthConnected ? (
            <div className="space-y-3">
              <div className="text-[13px]">
                <span className="text-gray-500">
                  {t('googleCalendar.connectedAs')}
                </span>{' '}
                <span className="font-medium">
                  {accountEmail || t('googleCalendar.accountTitle')}
                </span>
              </div>
              {calendars.length > 0 && (
                <Field label={t('googleCalendar.calendarPicker')}>
                  <Select
                    value={calendarId}
                    onChange={(e) => setCalendarId(e.target.value)}
                    disabled={loading}
                  >
                    {calendars.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.summary}
                        {c.primary ? ` (${t('googleCalendar.primary')})` : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-[13px] text-gray-400">
                {t('googleCalendar.connectHelp')}
              </div>
              <Button
                variant="primary"
                onClick={() => void connect()}
                disabled={loading || connecting || !oauthConfigured}
                loading={connecting}
              >
                {connecting
                  ? t('googleCalendar.connecting')
                  : t('googleCalendar.connect')}
              </Button>
            </div>
          )}
        </SettingsCard>

        <SettingsCard>
          <div className="space-y-4">
            <SettingsToggleRow
              title={t('googleCalendar.enableLabel')}
              checked={enabled}
              onChange={setEnabled}
              disabled={loading || !oauthConnected}
              label={t('googleCalendar.enableLabel')}
            />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Field label={t('googleCalendar.syncInterval')}>
                <Input
                  type="number"
                  min={5}
                  max={60}
                  value={syncIntervalMin}
                  onChange={(e) => setSyncIntervalMin(Number(e.target.value))}
                  disabled={loading}
                />
              </Field>
              <Field label={t('googleCalendar.defaultArea')}>
                <Select
                  value={defaultArea}
                  onChange={(e) => setDefaultArea(e.target.value)}
                  disabled={loading}
                >
                  {areas.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('googleCalendar.defaultDuration')}>
                <Input
                  type="number"
                  min={15}
                  max={720}
                  value={defaultDurationMin}
                  onChange={(e) =>
                    setDefaultDurationMin(Number(e.target.value))
                  }
                  disabled={loading}
                />
              </Field>
            </div>
          </div>
        </SettingsCard>

        <SettingsCard title={t('googleCalendar.eventFormatTitle')}>
          <pre className="whitespace-pre-wrap font-mono text-[12px] text-gray-400">
            {t('googleCalendar.eventFormatExample')}
          </pre>
        </SettingsCard>

        {(lastSyncAt || lastSyncMessage || lastSyncError) && (
          <SettingsCard title={t('googleCalendar.lastSync')}>
            <div className="space-y-1 text-[13px]">
              {lastSyncAt && (
                <div className="text-gray-400">
                  {new Date(lastSyncAt).toLocaleString()}
                </div>
              )}
              {lastSyncMessage && (
                <div className="text-emerald-300">{lastSyncMessage}</div>
              )}
              {lastSyncError && (
                <div className="text-rose-300">{lastSyncError}</div>
              )}
            </div>
          </SettingsCard>
        )}

        {status ? <SettingsStatus>{status}</SettingsStatus> : null}
      </div>
    </div>
  );
}

function KdsSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<string | null>(null);
  const [kdsOn, setKdsOn] = useState(true);
  const [savingMaster, setSavingMaster] = useState(false);
  const [stations, setStations] = useState<Record<KdsStation, boolean>>(() => {
    const init = {} as Record<KdsStation, boolean>;
    for (const st of ALL_KDS_STATIONS) init[st] = true;
    return init;
  });
  const [loadingStations, setLoadingStations] = useState(true);
  const [savingStation, setSavingStation] = useState<KdsStation | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s: any = await window.api.settings.get();
        const map = s?.kds?.stations;
        if (!alive) return;
        setKdsOn(s?.kds?.enabled !== false);
        setStations((prev) => {
          const next = { ...prev };
          for (const st of ALL_KDS_STATIONS) {
            next[st] = !map || map[st] !== false;
          }
          return next;
        });
      } catch {
        /* keep defaults (all enabled) */
      } finally {
        if (alive) setLoadingStations(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const toggleMaster = async () => {
    const next = !kdsOn;
    setKdsOn(next);
    setSavingMaster(true);
    setStatus(null);
    try {
      await window.api.settings.update({ kds: { enabled: next } } as any);
      setStatus(next ? t('kdsSettings.masterOn') : t('kdsSettings.masterOff'));
    } catch {
      setKdsOn(!next);
      setStatus(t('kdsSettings.masterSaveFailed'));
    } finally {
      setSavingMaster(false);
    }
  };

  const toggleStation = async (station: KdsStation) => {
    const next = { ...stations, [station]: !stations[station] };
    setStations(next);
    setSavingStation(station);
    setStatus(null);
    try {
      await window.api.settings.update({ kds: { stations: next } });
      setStatus(
        next[station]
          ? t('kdsSettings.stationEnabled', {
              station: t(`kdsSettings.station${station}`),
            })
          : t('kdsSettings.stationDisabled', {
              station: t(`kdsSettings.station${station}`),
            }),
      );
    } catch {
      // Roll back on failure.
      setStations((prev) => ({ ...prev, [station]: !next[station] }));
      setStatus(
        t('kdsSettings.stationSaveFailed', {
          station: t(`kdsSettings.station${station}`),
        }),
      );
    } finally {
      setSavingStation(null);
    }
  };

  return (
    <div>
      <SettingsHeader
        title={t('kdsSettings.title')}
        description={t('kdsSettings.updatesHelp')}
        actions={
          <Button
            variant="primary"
            disabled={!kdsOn}
            onClick={async () => {
              setStatus(null);
              await window.api.kds.openWindow();
            }}
          >
            {t('kdsSettings.openWindow')}
          </Button>
        }
      />
      <div className="space-y-3">
        <SettingsCard>
          <SettingsToggleRow
            title={t('kdsSettings.masterLabel')}
            description={t('kdsSettings.masterHelp')}
            checked={kdsOn}
            onChange={() => void toggleMaster()}
            disabled={loadingStations || savingMaster}
            label={t('kdsSettings.masterLabel')}
          />
        </SettingsCard>

        <SettingsCard
          title={t('kdsSettings.stationsTitle')}
          description={t('kdsSettings.stationsHelp')}
        >
          <div className={`space-y-4 ${kdsOn ? '' : 'opacity-50'}`}>
            {ALL_KDS_STATIONS.map((st) => (
              <SettingsToggleRow
                key={st}
                title={t(`kdsSettings.station${st}`)}
                checked={stations[st]}
                onChange={() => void toggleStation(st)}
                disabled={!kdsOn || loadingStations || savingStation === st}
                label={t(`kdsSettings.station${st}`)}
              />
            ))}
          </div>
        </SettingsCard>

        <SettingsCard
          title={t('kdsSettings.bumpTitle')}
          description={t('kdsSettings.bumpHelp')}
          padded={false}
        >
          <div className="overflow-x-auto">
            <table className="pos-table text-[12px]">
              <thead>
                <tr>
                  <th>{t('kdsSettings.bumpButton')}</th>
                  <th>{t('kdsSettings.bumpKeystroke')}</th>
                  <th>{t('kdsSettings.bumpAction')}</th>
                </tr>
              </thead>
              <tbody>
                {KDS_BUMP_BAR_PROGRAMMING.map((row) => (
                  <tr key={row.button}>
                    <td className="font-medium">{row.button}</td>
                    <td className="font-mono">{row.keystroke}</td>
                    <td className="text-gray-400">{row.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SettingsCard>

        {!kdsOn ? (
          <SettingsStatus>{t('kdsSettings.openWindowDisabled')}</SettingsStatus>
        ) : null}
        {status ? <SettingsStatus>{status}</SettingsStatus> : null}
      </div>
    </div>
  );
}

function AddRouteModal({
  availableCategories,
  enabledProfiles,
  routingEnabled,
  onAdd,
  onClose,
}: {
  availableCategories: Array<{ id: number; name: string }>;
  enabledProfiles: Array<{ id: string; name: string; mode?: string }>;
  routingEnabled: boolean;
  onAdd: (catId: string, printerId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [catId, setCatId] = useState('');
  const [printerId, setPrinterId] = useState('default');

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
        onClick={onClose}
        aria-label={t('settingsPrinter.closeModal')}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 shadow-2xl overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between gap-3">
          <div className="font-semibold">
            {t('settingsPrinter.addRouteTitle')}
          </div>
          <button
            type="button"
            className="w-9 h-9 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 flex items-center justify-center"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              className="pos-icon"
            >
              <path
                d="M6 6l12 12M18 6 6 18"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="p-4 space-y-4">
          <label className="block text-sm">
            <div className="opacity-80 mb-1">
              {t('settingsPrinter.category')}
            </div>
            <select
              className="w-full bg-gray-700 rounded px-3 py-2"
              value={catId}
              onChange={(e) => setCatId(String(e.target.value || ''))}
              disabled={!routingEnabled}
            >
              <option value="">{t('settingsPrinter.selectCategory')}</option>
              {availableCategories.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <div className="opacity-80 mb-1">
              {t('settingsPrinter.printer')}
            </div>
            <select
              className="w-full bg-gray-700 rounded px-3 py-2"
              value={printerId}
              onChange={(e) =>
                setPrinterId(String(e.target.value || 'default'))
              }
              disabled={!routingEnabled}
            >
              {enabledProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.mode || 'NETWORK'})
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2 pt-2">
            <Button
              variant="primary"
              className="flex-1"
              disabled={!routingEnabled || !catId}
              onClick={() => onAdd(catId, printerId)}
            >
              {t('settingsPrinter.addRouteBtn')}
            </Button>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

type PrinterProfile = {
  id: string;
  name: string;
  enabled?: boolean;
  mode?: 'NETWORK' | 'SYSTEM' | 'SERIAL';
  ip?: string;
  port?: number;
  deviceName?: string;
  silent?: boolean;
  systemRawEscpos?: boolean;
  serialPath?: string;
  baudRate?: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: 'none' | 'even' | 'odd';
  paperWidthMm?: 58 | 80;
};

function PrinterSettings() {
  type Profile = PrinterProfile;
  const { t } = useTranslation();

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [routingEnabled, setRoutingEnabled] = useState(false);
  const [receiptPrinterId, setReceiptPrinterId] = useState<string>('default');
  // Single fallback printer for ORDER items that don't match a category route.
  const [fallbackPrinterId, setFallbackPrinterId] = useState<string>('default');
  // Category routing (optional). Key is categoryId string (e.g. "12") for stability.
  const [categoryRouting, setCategoryRouting] = useState<
    Record<string, string>
  >({});
  const [menuCategories, setMenuCategories] = useState<
    Array<{ id: number; name: string }>
  >([]);
  const [showAddRouteModal, setShowAddRouteModal] = useState(false);

  const [printers, setPrinters] = useState<
    { name: string; isDefault?: boolean }[]
  >([]);
  const [serialPorts, setSerialPorts] = useState<
    { path: string; manufacturer?: string }[]
  >([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const ensureProfile = (p: any, idx: number): Profile => {
    // CORRECTNESS: previously used Math.random() which produced a different id
    // on every render — that broke React keys and re-mounted list rows on
    // every save/transform, dropping focus and causing reconciliation churn.
    const id = String(p?.id || `p${idx}`);
    const mode: any =
      p?.mode ||
      (p?.serialPath ? 'SERIAL' : p?.deviceName ? 'SYSTEM' : 'NETWORK');
    return {
      id,
      name: String(p?.name || `Printer ${idx + 1}`),
      enabled: p?.enabled !== false,
      mode:
        mode === 'SYSTEM' ? 'SYSTEM' : mode === 'SERIAL' ? 'SERIAL' : 'NETWORK',
      ip: p?.ip ? String(p.ip) : '',
      port: Number(p?.port || 9100),
      deviceName: p?.deviceName ? String(p.deviceName) : '',
      silent: p?.silent !== false,
      systemRawEscpos: p?.systemRawEscpos !== false,
      serialPath: p?.serialPath ? String(p.serialPath) : '',
      baudRate: Number(p?.baudRate || 19200),
      dataBits: (Number(p?.dataBits || 8) === 7 ? 7 : 8) as 7 | 8,
      stopBits: (Number(p?.stopBits || 1) === 2 ? 2 : 1) as 1 | 2,
      parity: String(p?.parity || 'none') as any as 'none' | 'even' | 'odd',
      paperWidthMm: Number(p?.paperWidthMm) === 58 ? 58 : 80,
    };
  };

  useEffect(() => {
    (async () => {
      const s = await window.api.settings.get();

      const legacy: any = (s as any)?.printer || {};
      const arr: any[] =
        Array.isArray((s as any)?.printers) && (s as any).printers.length
          ? (s as any).printers
          : legacy && Object.keys(legacy).length
            ? [
                {
                  id: 'default',
                  name: 'Default printer',
                  enabled: true,
                  ...legacy,
                },
              ]
            : [];
      setProfiles(arr.map((p, idx) => ensureProfile(p, idx)));

      const r: any = (s as any)?.printerRouting || {};
      setRoutingEnabled(Boolean(r?.enabled));
      setReceiptPrinterId(String(r?.receiptPrinterId || 'default'));
      setFallbackPrinterId(
        String(r?.fallbackPrinterId || r?.station?.ALL || 'default'),
      );
      // Category routing: allow routing by the *actual* menu categories.
      // Storage format: mapping of categoryId (string) -> printerProfileId.
      const rawCats = (await window.api.menu
        .listCategoriesWithItems()
        .catch(() => [] as any[])) as any[];
      const cats = (Array.isArray(rawCats) ? rawCats : []).map((c: any) => ({
        id: Number(c?.id || 0),
        name: String(c?.name || '').trim(),
      }));
      setMenuCategories(cats.filter((c) => c.id > 0 && c.name));
      const norm = (x: any) =>
        String(x ?? '')
          .trim()
          .toLowerCase();
      const nameToId = new Map<string, number>();
      for (const c of cats) {
        if (c.id > 0 && c.name) nameToId.set(norm(c.name), c.id);
      }
      const rawCatMap: Record<string, string> = (r?.categories || {}) as any;
      const next: Record<string, string> = {};
      for (const [k0, v0] of Object.entries(rawCatMap || {})) {
        const k = String(k0 || '').trim();
        const v = String(v0 || '').trim();
        if (!v) continue;
        // Prefer stable id keys.
        if (/^\d+$/.test(k)) {
          next[k] = v;
          continue;
        }
        // Backward compat: name-based keys (normalized) -> map to id.
        const id = nameToId.get(norm(k));
        if (id) {
          next[String(id)] = v;
          continue;
        }
        // Unknown key: keep it (but UI will show it as unknown).
        next[k] = v;
      }
      setCategoryRouting(next);

      try {
        const list =
          (await (window.api.settings as any).listPrinters?.()) || [];
        setPrinters(list);
      } catch {
        // ignore
      }
      try {
        const list =
          (await (window.api.settings as any).listSerialPorts?.()) || [];
        setSerialPorts(list);
      } catch {
        setStatus(t('settingsPrinter.serialUnavailable'));
      }
    })();
  }, []);

  const enabledProfiles = profiles.filter((p) => p.enabled !== false);
  const pickOptions = (includeEmpty = true) => (
    <>
      {includeEmpty && <option value="">(not set)</option>}
      {enabledProfiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} ({p.mode})
        </option>
      ))}
    </>
  );

  const categoryNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of menuCategories) m.set(Number(c.id), String(c.name || ''));
    return m;
  }, [menuCategories]);

  const routedEntries = useMemo(() => {
    const out: Array<{
      key: string;
      categoryId: number | null;
      label: string;
      printerId: string;
    }> = [];
    for (const [k, v] of Object.entries(categoryRouting || {})) {
      const printerId = String(v || '').trim();
      if (!printerId) continue;
      const categoryId = /^\d+$/.test(k) ? Number(k) : null;
      const label =
        categoryId != null
          ? categoryNameById.get(categoryId) ||
            t('settingsPrinter.missingCategory', { id: categoryId })
          : t('settingsPrinter.categoryKey', { key: k });
      out.push({ key: k, categoryId, label, printerId });
    }
    // stable order: known categories first, then unknown keys
    out.sort((a, b) => {
      const ak = a.categoryId == null ? 9 : 0;
      const bk = b.categoryId == null ? 9 : 0;
      if (ak !== bk) return ak - bk;
      return a.label.localeCompare(b.label);
    });
    return out;
  }, [categoryRouting, categoryNameById, t]);

  const availableCategoriesToAdd = useMemo(() => {
    const used = new Set<string>();
    for (const k of Object.keys(categoryRouting || {})) {
      if (/^\d+$/.test(k)) used.add(String(k));
    }
    return menuCategories.filter((c) => c.id > 0 && !used.has(String(c.id)));
  }, [menuCategories, categoryRouting]);

  return (
    <div>
      <SettingsHeader
        title={t('settingsPrinter.title')}
        actions={
          <Button
            variant="primary"
            disabled={saving}
            loading={saving}
            onClick={async () => {
              setSaving(true);
              setStatus(null);
              try {
                await window.api.settings.update({
                  printers: profiles,
                  printerRouting: {
                    enabled: routingEnabled,
                    receiptPrinterId,
                    station: { ALL: fallbackPrinterId || undefined },
                    fallbackPrinterId: fallbackPrinterId || undefined,
                    categories: categoryRouting,
                  },
                } as any);
                setStatus(t('settingsPrinter.saved'));
              } catch (e: any) {
                setStatus(
                  String(e?.message || t('settingsPrinter.saveFailed')),
                );
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? t('common.saving') : t('settingsPrinter.save')}
          </Button>
        }
      />

      {status ? (
        <div className="mb-3">
          <SettingsStatus tone="warn">{status}</SettingsStatus>
        </div>
      ) : null}

      <div className="space-y-3">
        <SettingsCard
          title={t('settingsPrinter.routing')}
          description={t('settingsPrinter.routingHelp')}
          actions={
            <Button
              disabled={!routingEnabled}
              onClick={() => setShowAddRouteModal(true)}
            >
              {t('settingsPrinter.addRoute')}
            </Button>
          }
        >
          <div className="space-y-3">
            <SettingsToggleRow
              title={t('settingsPrinter.enableRouting')}
              checked={routingEnabled}
              onChange={setRoutingEnabled}
              label={t('settingsPrinter.enableRouting')}
            />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label={t('settingsPrinter.receiptPrinter')}>
                <Select
                  value={receiptPrinterId}
                  onChange={(e) => setReceiptPrinterId(e.target.value)}
                  disabled={!routingEnabled}
                >
                  {pickOptions(false)}
                </Select>
              </Field>
              <Field label={t('settingsPrinter.fallbackPrinter')}>
                <Select
                  value={fallbackPrinterId}
                  onChange={(e) => setFallbackPrinterId(e.target.value)}
                  disabled={!routingEnabled}
                >
                  {pickOptions(false)}
                </Select>
              </Field>
            </div>
            {routedEntries.length === 0 ? (
              <div className="text-[12px] text-gray-500">
                {t('settingsPrinter.noRoutes')}
              </div>
            ) : (
              <div className="divide-y divide-white/7 overflow-hidden rounded-md border border-white/7">
                {routedEntries.map((r) => (
                  <div
                    key={r.key}
                    className="flex items-center gap-2 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">
                        {r.label}
                      </div>
                      {r.categoryId == null && (
                        <div className="text-[11px] text-gray-500">
                          {t('settingsPrinter.unknownKey')}
                        </div>
                      )}
                    </div>
                    <Select
                      className="w-[160px]"
                      value={r.printerId}
                      disabled={!routingEnabled}
                      onChange={(e) =>
                        setCategoryRouting((m) => ({
                          ...(m || {}),
                          [r.key]: String(e.target.value || ''),
                        }))
                      }
                    >
                      {pickOptions(false)}
                    </Select>
                    <KebabMenu
                      label={t('settingsPrinter.removeRouteAria', {
                        label: r.label,
                      })}
                      items={[
                        {
                          label: t('common.remove'),
                          danger: true,
                          disabled: !routingEnabled,
                          onSelect: () =>
                            setCategoryRouting((m) => {
                              const next = { ...(m || {}) } as any;
                              delete next[r.key];
                              return next;
                            }),
                        },
                      ]}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </SettingsCard>

        {showAddRouteModal && (
          <AddRouteModal
            availableCategories={availableCategoriesToAdd}
            enabledProfiles={enabledProfiles}
            routingEnabled={routingEnabled}
            onAdd={(catId, printerId) => {
              const cid = String(catId || '').trim();
              if (!cid) return;
              setCategoryRouting((m) => ({
                ...(m || {}),
                [cid]: String(printerId || 'default'),
              }));
              setShowAddRouteModal(false);
            }}
            onClose={() => setShowAddRouteModal(false)}
          />
        )}

        <div className="flex items-center justify-between gap-3">
          <div className="text-[13px] font-semibold text-gray-100">
            {t('settingsPrinter.profiles')}
          </div>
          <Button
            onClick={() =>
              setProfiles((arr) => [
                ...arr,
                ensureProfile(
                  {
                    name: t('settingsPrinter.printerN', {
                      n: arr.length + 1,
                    }),
                    enabled: true,
                    mode: 'NETWORK',
                  },
                  arr.length,
                ),
              ])
            }
          >
            {t('settingsPrinter.addPrinter')}
          </Button>
        </div>

        <div className="space-y-2">
          {profiles.map((p) => (
            <PrinterProfileCard
              key={p.id}
              profile={p}
              printers={printers}
              serialPorts={serialPorts}
              onUpdate={(patch) =>
                setProfiles((arr) =>
                  arr.map((x) => (x.id === p.id ? { ...x, ...patch } : x)),
                )
              }
              onDelete={() =>
                setProfiles((arr) => arr.filter((x) => x.id !== p.id))
              }
              onRefreshPrinters={async () => {
                const list =
                  (await (window.api.settings as any).listPrinters?.()) || [];
                setPrinters(list);
              }}
              onRefreshSerial={async () => {
                try {
                  const list =
                    (await (window.api.settings as any).listSerialPorts?.()) ||
                    [];
                  setSerialPorts(list);
                  if (!list.length) setStatus(t('settingsPrinter.noSerial'));
                } catch (e: any) {
                  setStatus(
                    String(
                      e?.message || t('settingsPrinter.serialUnavailable'),
                    ),
                  );
                }
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function PrinterProfileCard({
  profile: p,
  printers,
  serialPorts,
  onUpdate,
  onDelete,
  onRefreshPrinters,
  onRefreshSerial,
}: {
  profile: PrinterProfile;
  printers: { name: string; isDefault?: boolean }[];
  serialPorts: { path: string; manufacturer?: string }[];
  onUpdate: (patch: Partial<PrinterProfile>) => void;
  onDelete: () => void;
  onRefreshPrinters: () => Promise<void>;
  onRefreshSerial: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // Local test-print feedback. We deliberately keep it in the card (not the
  // parent) so each profile has its own independent status line.
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanHint, setScanHint] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<NetworkPrinterDTO[]>([]);

  async function runTestPrint() {
    setTesting(true);
    setTestResult(null);
    try {
      const fn = (window.api.settings as any).testPrintProfile as
        | ((
            profile: PrinterProfile,
          ) => Promise<{ ok: boolean; error?: string }>)
        | undefined;
      if (typeof fn !== 'function') {
        setTestResult({
          ok: false,
          msg: t('settingsPrinter.testUnavailable'),
        });
        return;
      }
      const r = await fn(p);
      if (r?.ok) {
        setTestResult({
          ok: true,
          msg: t('settingsPrinter.testSent'),
        });
      } else {
        setTestResult({
          ok: false,
          msg: r?.error || t('settingsPrinter.testFailed'),
        });
      }
    } catch (e: any) {
      setTestResult({
        ok: false,
        msg: String(e?.message || e || t('settingsPrinter.testFailed')),
      });
    } finally {
      setTesting(false);
    }
  }

  async function runNetworkScan() {
    setScanning(true);
    setScanHint(null);
    try {
      const fn = window.api.settings.scanNetworkPrinters;
      if (typeof fn !== 'function') {
        setScanHint(t('settingsPrinter.scanUnavailable'));
        return;
      }
      const list = (await fn()) || [];
      setDiscovered(list);
      if (list.length === 0) {
        setScanHint(t('settingsPrinter.scanNone'));
        return;
      }
      setScanHint(
        list.length === 1
          ? t('settingsPrinter.foundOne')
          : t('settingsPrinter.foundMany', { count: list.length }),
      );
      // One hit and this profile has no address yet — pick it so the
      // admin does not have to open the dropdown for a single device.
      if (list.length === 1 && !String(p.ip || '').trim()) {
        applyDiscovered(list[0]);
      }
    } catch (e: any) {
      setScanHint(String(e?.message || e || t('settingsPrinter.scanFailed')));
    } finally {
      setScanning(false);
    }
  }

  function applyDiscovered(hit: NetworkPrinterDTO) {
    const genericName =
      !p.name || /^(Default printer|Printer \d+)$/i.test(p.name);
    onUpdate({
      ip: hit.ip,
      port: hit.port,
      ...(genericName && hit.source === 'mdns' && hit.name
        ? { name: hit.name }
        : {}),
    });
  }

  const selectedKey = p.ip
    ? `${String(p.ip).trim()}:${Number(p.port || 9100)}`
    : '';
  const dropdownOptions = (() => {
    const rows = [...discovered];
    if (
      p.ip &&
      !rows.some(
        (d) =>
          d.ip === String(p.ip).trim() && d.port === Number(p.port || 9100),
      )
    ) {
      rows.unshift({
        ip: String(p.ip).trim(),
        port: Number(p.port || 9100),
        name: `${p.name || 'Current'} (${p.ip}:${p.port || 9100})`,
        source: 'tcp',
      });
    }
    return rows;
  })();
  const mode = p.mode || 'NETWORK';
  const modeLabel =
    mode === 'NETWORK'
      ? t('settingsPrinter.modeNetwork')
      : mode === 'SYSTEM'
        ? t('settingsPrinter.modeUsb')
        : t('settingsPrinter.modeSerial');
  const connectionDetail =
    mode === 'NETWORK'
      ? `${p.ip || '—'}:${p.port || 9100}`
      : mode === 'SYSTEM'
        ? p.deviceName || t('settingsPrinter.defaultPrinterParen')
        : p.serialPath || t('settingsPrinter.noneParen');

  return (
    <div className="overflow-visible rounded-lg border border-white/7 bg-[var(--pos-canvas)]">
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left hover:bg-white/[0.03]"
          onClick={() => setExpanded((v) => !v)}
        >
          <span
            className="transition-transform duration-150"
            style={{ transform: expanded ? 'rotate(90deg)' : undefined }}
          >
            <ChevronRight />
          </span>

          <span className="flex-1 truncate font-semibold">{p.name}</span>

          <Badge>{modeLabel}</Badge>
          <Badge tone={p.enabled !== false ? 'accent' : 'neutral'} dot>
            {p.enabled !== false
              ? t('settingsPrinter.enabled')
              : t('settingsPrinter.disabled')}
          </Badge>
        </button>
        <KebabMenu
          label={t('common.moreActions')}
          items={[
            {
              label: testing
                ? t('settingsPrinter.printing')
                : t('settingsPrinter.testPrint'),
              onSelect: () => void runTestPrint(),
              disabled:
                testing ||
                (mode === 'NETWORK' && !p.ip) ||
                (mode === 'SERIAL' && !p.serialPath),
            },
            {
              label: t('settingsPrinter.removePrinter'),
              onSelect: onDelete,
              danger: true,
            },
          ]}
        />
      </div>

      <div className="px-3 pb-1 -mt-1 text-[11px] text-gray-500 flex items-center gap-2">
        <span>ID: {p.id}</span>
        <span className="opacity-40">·</span>
        <span className="truncate">{connectionDetail}</span>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-2 space-y-3 border-t border-gray-700/50 mt-1">
          <div className="space-y-3">
            <Input
              placeholder={t('settingsPrinter.namePlaceholder')}
              value={p.name}
              onChange={(e) => onUpdate({ name: e.target.value })}
            />
            <SettingsToggleRow
              title={t('settingsPrinter.enabled')}
              checked={p.enabled !== false}
              onChange={(next) => onUpdate({ enabled: next })}
              label={t('settingsPrinter.enabled')}
            />
          </div>

          <select
            className="bg-gray-700 rounded px-3 py-2 w-full"
            value={mode}
            onChange={(e) => onUpdate({ mode: e.target.value as any })}
          >
            <option value="NETWORK">
              {t('settingsPrinter.modeNetworkOpt')}
            </option>
            <option value="SYSTEM">{t('settingsPrinter.modeUsbOpt')}</option>
            <option value="SERIAL">{t('settingsPrinter.modeSerialOpt')}</option>
          </select>

          <label className="flex items-center gap-2 text-sm">
            {t('settingsPrinter.paperWidth')}
            <select
              className="bg-gray-700 rounded px-3 py-2 flex-1"
              value={p.paperWidthMm === 58 ? 58 : 80}
              onChange={(e) =>
                onUpdate({
                  paperWidthMm: Number(e.target.value) === 58 ? 58 : 80,
                })
              }
            >
              <option value={80}>{t('settingsPrinter.paper80')}</option>
              <option value={58}>{t('settingsPrinter.paper58')}</option>
            </select>
          </label>

          {mode === 'NETWORK' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <select
                  className="bg-gray-700 rounded px-3 py-2 flex-1"
                  value={selectedKey}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!v) {
                      onUpdate({ ip: '', port: 9100 });
                      return;
                    }
                    const [ip, portStr] = v.split(':');
                    const hit =
                      discovered.find((d) => `${d.ip}:${d.port}` === v) ||
                      ({
                        ip,
                        port: Number(portStr || 9100),
                        name: '',
                        source: 'tcp' as const,
                      } satisfies NetworkPrinterDTO);
                    applyDiscovered(hit);
                  }}
                >
                  <option value="">
                    {scanning
                      ? t('settingsPrinter.scanning')
                      : t('settingsPrinter.selectPrinter')}
                  </option>
                  {dropdownOptions.map((d) => (
                    <option
                      key={`${d.ip}:${d.port}`}
                      value={`${d.ip}:${d.port}`}
                    >
                      {d.name} — {d.ip}:{d.port}
                    </option>
                  ))}
                </select>
                <Button
                  disabled={scanning}
                  onClick={() => void runNetworkScan()}
                >
                  {scanning
                    ? t('settingsPrinter.scanning')
                    : t('settingsPrinter.scan')}
                </Button>
              </div>
              <div className="text-xs opacity-70">
                Scan finds receipt printers on this LAN (raw port 9100). If
                yours is missing, type the address below.
              </div>
              {scanHint ? (
                <div className="text-xs text-amber-200">{scanHint}</div>
              ) : null}
              <div className="flex items-center gap-2">
                <input
                  className="bg-gray-700 rounded px-3 py-2 flex-1"
                  placeholder={t('settingsPrinter.ipPlaceholder')}
                  value={p.ip || ''}
                  onChange={(e) => onUpdate({ ip: e.target.value })}
                />
                <input
                  className="w-28 bg-gray-700 rounded px-3 py-2"
                  type="number"
                  min={1}
                  value={Number(p.port || 9100)}
                  onChange={(e) => onUpdate({ port: Number(e.target.value) })}
                />
              </div>
            </div>
          )}

          {mode === 'SYSTEM' && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <select
                  className="bg-gray-700 rounded px-3 py-2 flex-1"
                  value={p.deviceName || ''}
                  onChange={(e) => onUpdate({ deviceName: e.target.value })}
                >
                  <option value="">(default printer)</option>
                  {printers.map((sp) => (
                    <option key={sp.name} value={sp.name}>
                      {sp.name}
                      {sp.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
                <Button onClick={() => void onRefreshPrinters()}>
                  {t('settingsPrinter.refresh')}
                </Button>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={p.silent !== false}
                  onChange={(e) => onUpdate({ silent: e.target.checked })}
                />
                Silent print (no OS dialog)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={p.systemRawEscpos !== false}
                  onChange={(e) =>
                    onUpdate({ systemRawEscpos: e.target.checked })
                  }
                />
                Send raw ESC/POS (recommended for receipt printers)
              </label>
            </div>
          )}

          {mode === 'SERIAL' && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <select
                  className="bg-gray-700 rounded px-3 py-2 flex-1"
                  value={p.serialPath || ''}
                  onChange={(e) => onUpdate({ serialPath: e.target.value })}
                >
                  <option value="">{t('settingsPrinter.selectSerial')}</option>
                  {serialPorts.map((sp) => (
                    <option key={sp.path} value={sp.path}>
                      {sp.path}
                      {sp.manufacturer ? ` (${sp.manufacturer})` : ''}
                    </option>
                  ))}
                </select>
                <Button onClick={() => void onRefreshSerial()}>
                  {t('settingsPrinter.refresh')}
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="bg-gray-700 rounded px-3 py-2"
                  type="number"
                  min={1200}
                  placeholder={t('settingsPrinter.baudPlaceholder')}
                  value={Number(p.baudRate || 19200)}
                  onChange={(e) =>
                    onUpdate({ baudRate: Number(e.target.value) })
                  }
                />
                <select
                  className="bg-gray-700 rounded px-3 py-2"
                  value={p.parity || 'none'}
                  onChange={(e) => onUpdate({ parity: e.target.value as any })}
                >
                  <option value="none">
                    {t('settingsPrinter.parityNone')}
                  </option>
                  <option value="even">
                    {t('settingsPrinter.parityEven')}
                  </option>
                  <option value="odd">{t('settingsPrinter.parityOdd')}</option>
                </select>
                <select
                  className="bg-gray-700 rounded px-3 py-2"
                  value={p.dataBits || 8}
                  onChange={(e) =>
                    onUpdate({ dataBits: Number(e.target.value) as any })
                  }
                >
                  <option value={8}>{t('settingsPrinter.data8')}</option>
                  <option value={7}>{t('settingsPrinter.data7')}</option>
                </select>
                <select
                  className="bg-gray-700 rounded px-3 py-2"
                  value={p.stopBits || 1}
                  onChange={(e) =>
                    onUpdate({ stopBits: Number(e.target.value) as any })
                  }
                >
                  <option value={1}>{t('settingsPrinter.stop1')}</option>
                  <option value={2}>{t('settingsPrinter.stop2')}</option>
                </select>
              </div>
              <div className="text-xs opacity-70">
                Typical Epson: 19200, none, 8, 1.
              </div>
            </div>
          )}

          {/* Test print: sends a "Hello, world!" ESC/POS slip directly to the
              CURRENT (in-memory) profile so admins can validate config
              before saving. Disabled when the profile lacks a destination. */}
          <div className="pt-2 border-t border-gray-700/50">
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                disabled={
                  testing ||
                  (mode === 'NETWORK' && !p.ip) ||
                  (mode === 'SERIAL' && !p.serialPath)
                }
                onClick={() => void runTestPrint()}
              >
                {testing
                  ? t('settingsPrinter.printing')
                  : t('settingsPrinter.testPrint')}
              </Button>
              <span className="text-[11px] opacity-60">
                Sends a Hello-World slip with the values currently shown above
                (no save needed).
              </span>
            </div>
            {testResult && (
              <div
                className={`mt-2 text-xs ${
                  testResult.ok ? 'text-emerald-300' : 'text-rose-300'
                }`}
              >
                {testResult.msg}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AreasSettings() {
  const { t } = useTranslation();
  const [areas, setAreas] = useState<{ name: string; count: number }[]>([]);
  const [editingArea, setEditingArea] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const s = await window.api.settings.get();
      setAreas(s.tableAreas || []);
    })();
  }, []);
  return (
    <div>
      <SettingsHeader
        title={t('settingsAreas.title')}
        description={t('settingsAreas.help')}
        actions={
          <>
            <Button
              onClick={() =>
                setAreas((arr) => [...arr, { name: '', count: 8 }])
              }
            >
              {t('settingsAreas.addArea')}
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                await window.api.settings.update({
                  tableAreas: areas.filter((x) => String(x.name || '').trim()),
                });
                toast.success(t('settingsAreas.saved'));
              }}
            >
              {t('settingsAreas.save')}
            </Button>
          </>
        }
      />

      <div className="space-y-2">
        {areas.length === 0 ? (
          <SettingsCard>
            <div className="text-[13px] text-gray-400">
              {t('settingsAreas.help')}
            </div>
          </SettingsCard>
        ) : (
          areas.map((a, idx) => (
            <div
              key={idx}
              className="flex items-center gap-2 rounded-lg border border-white/7 bg-[var(--pos-canvas)] px-3 py-2"
            >
              <Input
                className="flex-1"
                value={a.name}
                onChange={(e) =>
                  setAreas((arr) =>
                    arr.map((x, i) =>
                      i === idx ? { ...x, name: e.target.value } : x,
                    ),
                  )
                }
              />
              <KebabMenu
                label={t('settingsAreas.removeAria', {
                  name: a.name || idx + 1,
                })}
                items={[
                  {
                    label: t('settingsAreas.editLayout'),
                    onSelect: () => {
                      if (!a.name) {
                        toast.error(t('settingsAreas.nameFirst'));
                        return;
                      }
                      setEditingArea(a.name);
                    },
                  },
                  {
                    label: t('common.remove'),
                    danger: true,
                    onSelect: () =>
                      setAreas((arr) => arr.filter((_, i) => i !== idx)),
                  },
                ]}
              />
            </div>
          ))
        )}
      </div>

      {editingArea && (
        <AreaLayoutEditorModal
          area={editingArea}
          onClose={() => setEditingArea(null)}
        />
      )}
    </div>
  );
}

// Modal that hosts the FloorCanvas in editable mode for a single area.
// The canvas writes to the shared `layout:global:<area>` key on the
// server; every other connected client receives a `layout:changed`
// broadcast and refetches automatically — see `broadcastLayoutChanged`
// in src/main/services/realtime.ts.
function AreaLayoutEditorModal({
  area,
  onClose,
}: {
  area: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // FloorCanvas needs *some* userId for legacy IPC compatibility but the
  // server now ignores it (the layout is shared). Use the admin's id if
  // available, otherwise the current POS user's, otherwise 0.
  const adminUser = useAdminSessionStore((s) => s.user);
  const posUser = useSessionStore((s) => s.user);
  const userId = Number(adminUser?.id || posUser?.id || 0);
  const [editable, setEditable] = useState(true);
  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md flex"
      onClick={onClose}
    >
      {/* Full-page editor so the design surface fills the screen and
          matches the dimensions/aspect of the waiter floor view. */}
      <div
        className="bg-gray-800 w-full h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-700 flex items-center gap-3 shrink-0">
          <div className="text-base font-semibold flex-1 truncate">
            {t('settingsAreas.layoutTitle', { area })}
          </div>
          <button type="button" className="pos-btn" onClick={onClose}>
            {t('settingsAreas.done')}
          </button>
        </div>
        <div className="flex-1 min-h-0 flex flex-col p-3 sm:p-4">
          <FloorCanvas
            userId={userId}
            area={area}
            editable={editable}
            onEditableChange={setEditable}
            fillAvailableHeight
          />
        </div>
        <div className="px-4 py-2 border-t border-gray-700 text-xs opacity-70 shrink-0">
          {t('settingsAreas.layoutHint')}
        </div>
      </div>
    </div>
  );
}

function AboutSettings() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [businessName, setBusinessName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s: any = await window.api.settings.get().catch(() => null);
        if (cancelled) return;
        setBusinessName(String(s?.restaurantName || '').trim());
        setAddress(String(s?.businessInfo?.address || ''));
        setPhone(String(s?.businessInfo?.phone || ''));
        setEmail(String(s?.businessInfo?.email || ''));
        setWebsite(String(s?.businessInfo?.website || ''));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setStatus(null);
    setSaving(true);
    try {
      const nm = String(businessName || '').trim();
      if (nm.length < 2) {
        setStatus(t('settingsAbout.nameRequired'));
        return;
      }
      const em = String(email || '').trim();
      if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
        setStatus(t('settingsAbout.emailInvalid'));
        return;
      }
      await window.api.settings.update({
        // Keep backward compatibility: this is the name used across the app today.
        restaurantName: nm,
        businessInfo: {
          address: String(address || ''),
          phone: String(phone || ''),
          email: em,
          website: String(website || ''),
        },
      } as any);
      setStatus(t('settingsAbout.saved'));
    } catch (e: any) {
      setStatus(String(e?.message || t('settingsAbout.saveFailed')));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SettingsHeader
        title={t('settingsAbout.title')}
        description={t('settingsAbout.receiptHint')}
        actions={
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={saving}
            loading={saving}
          >
            {saving ? t('common.saving') : t('settingsAbout.save')}
          </Button>
        }
      />
      {loading ? (
        <SettingsStatus>{t('common.loading')}</SettingsStatus>
      ) : (
        <SettingsCard>
          <div className="space-y-3">
            <Field label={t('settingsAbout.name')}>
              <Input
                placeholder={t('settingsAbout.namePlaceholder')}
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
              />
            </Field>
            <Field label={t('settingsAbout.address')}>
              <Textarea
                placeholder={t('settingsAbout.addressPlaceholder')}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </Field>
            <Field label={t('settingsAbout.phone')}>
              <Input
                placeholder="+355 …"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
            <Field label={t('settingsAbout.email')}>
              <Input
                placeholder="info@restaurant.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                inputMode="email"
              />
            </Field>
            <Field label={t('settingsAbout.website')}>
              <Input
                placeholder="https://restaurant.com"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                inputMode="url"
              />
            </Field>
            {status ? (
              <SettingsStatus tone="ok">{status}</SettingsStatus>
            ) : null}
          </div>
        </SettingsCard>
      )}
    </div>
  );
}

function LanSettings() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [allowLan, setAllowLan] = useState(false);
  const [requirePairingCode, setRequirePairingCode] = useState(true);
  const [pairingCode, setPairingCode] = useState<string>('');
  const [openAtLogin, setOpenAtLogin] = useState(true);
  const [ips, setIps] = useState<string[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const [s, ipList] = await Promise.all([
          window.api.settings.get(),
          window.api.network.getIps().catch(() => [] as string[]),
        ]);
        setAllowLan(Boolean((s as any)?.security?.allowLan));
        setRequirePairingCode(
          Boolean((s as any)?.security?.requirePairingCode ?? true),
        );
        setPairingCode(String((s as any)?.security?.pairingCode || ''));
        setOpenAtLogin((s as any)?.host?.openAtLogin !== false);
        setIps(ipList || []);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function pickBestLanIp(list: string[]): string {
    const rank = (ip: string) => {
      if (ip.startsWith('192.168.')) return 0; // most common Wi‑Fi LAN
      if (ip.startsWith('10.')) return 1;
      if (
        ip.startsWith('172.16.') ||
        ip.startsWith('172.17.') ||
        ip.startsWith('172.18.') ||
        ip.startsWith('172.19.')
      )
        return 3;
      if (ip.startsWith('172.2') || ip.startsWith('172.3')) return 3; // 172.20-31 (rough)
      if (ip.startsWith('172.')) return 4;
      return 9;
    };
    return (
      (list || [])
        .filter(Boolean)
        .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0] || ''
    );
  }

  const primaryIp = pickBestLanIp(ips);
  const LAN_HTTP = '3333';
  const LAN_HTTPS = '3443';
  // Hash routing: put setup params in ? before # so the shell reads them on first paint.
  const staffSetupUrl = primaryIp
    ? (() => {
        const q = new URLSearchParams({
          backend: primaryIp,
          http: LAN_HTTP,
          https: LAN_HTTPS,
        });
        if (requirePairingCode && pairingCode && /^\d{6}$/.test(pairingCode)) {
          q.set('pairing', pairingCode);
        }
        return `http://${primaryIp}:${LAN_HTTP}/renderer/?${q.toString()}#/`;
      })()
    : '';

  async function saveSecurity(next: {
    allowLan?: boolean;
    requirePairingCode?: boolean;
    pairingCode?: string;
  }) {
    try {
      const updated = await window.api.settings.update({
        security: next,
        host: { openAtLogin },
      } as any);
      setAllowLan(Boolean((updated as any)?.security?.allowLan));
      setRequirePairingCode(
        Boolean((updated as any)?.security?.requirePairingCode ?? true),
      );
      setPairingCode(
        String(
          (updated as any)?.security?.pairingCode || next.pairingCode || '',
        ),
      );
      setOpenAtLogin((updated as any)?.host?.openAtLogin !== false);
      toast.success(t('adminLan.saved'));
    } catch (e: any) {
      toast.error(String(e?.message || t('adminLan.saveFailed')));
    }
  }

  return (
    <div>
      <SettingsHeader
        title={t('adminLan.title')}
        actions={
          <Button
            variant="primary"
            onClick={() => void saveSecurity({ allowLan, requirePairingCode })}
          >
            {t('adminLan.save')}
          </Button>
        }
      />

      {loading ? (
        <SettingsStatus>{t('common.loading')}</SettingsStatus>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border border-emerald-800/50 bg-emerald-950/30 px-4 py-3">
            <div className="text-[13px] font-semibold text-emerald-100">
              {t('adminLan.hostRunningTitle')}
            </div>
            <div className="mt-1 text-[12px] text-emerald-200/80">
              {t('adminLan.hostRunningBody')}
            </div>
          </div>

          <SettingsCard>
            <div className="space-y-4">
              <SettingsToggleRow
                title={t('adminLan.openAtLogin')}
                description={t('adminLan.openAtLoginHint')}
                checked={openAtLogin}
                onChange={setOpenAtLogin}
                label={t('adminLan.openAtLogin')}
              />
              <SettingsToggleRow
                title={t('adminLan.allowBrowser')}
                description={t('adminLan.allowBrowserHelp')}
                checked={allowLan}
                onChange={setAllowLan}
                label={t('adminLan.allowBrowser')}
              />
              <SettingsToggleRow
                title={t('adminLan.requirePairing')}
                description={t('adminLan.requirePairingHelp')}
                checked={requirePairingCode}
                onChange={setRequirePairingCode}
                label={t('adminLan.requirePairing')}
              />
            </div>
          </SettingsCard>

          {!allowLan && (
            <SettingsCard>
              <div className="text-[12px] text-gray-400">
                {t('adminLan.browserDisabled')}
              </div>
            </SettingsCard>
          )}

          <SettingsCard
            title={t('adminLan.pairingCode')}
            description={t('adminLan.pairingHint')}
            actions={
              <KebabMenu
                label={t('common.moreActions')}
                items={[
                  {
                    label: t('adminLan.regenerate'),
                    onSelect: () => {
                      const code = String(
                        Math.floor(100000 + Math.random() * 900000),
                      );
                      void saveSecurity({ pairingCode: code });
                    },
                  },
                ]}
              />
            }
          >
            <Input value={pairingCode || t('adminLan.notGenerated')} readOnly />
          </SettingsCard>

          <SettingsCard
            title={t('adminLan.setupLink')}
            description={
              staffSetupUrl ? t('adminLan.setupHint') : t('adminLan.noWifi')
            }
            actions={
              staffSetupUrl ? (
                <Button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(staffSetupUrl);
                      toast.success(t('adminLan.copied'));
                    } catch {
                      toast.error(t('adminLan.copyFailed'));
                    }
                  }}
                >
                  {t('adminLan.copy')}
                </Button>
              ) : undefined
            }
          >
            {staffSetupUrl ? (
              <Input className="text-[12px]" value={staffSetupUrl} readOnly />
            ) : null}
          </SettingsCard>
        </div>
      )}
    </div>
  );
}
