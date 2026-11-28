/**
 * Header status lights (`@shared/statusLights`): Fiscal, Printers, Backup,
 * Devices, Database. Each dot has a shape as well as a colour (● ok,
 * ▲ needs attention, ■ not working) so it reads without colour. Tap one
 * for the message and what to do. Read every 10 s while the window is
 * shown; the dots re-render only when something changed.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { newlyRed, type StatusLight } from '@shared/statusLights';

const POLL_MS = 10_000;
const SOUND_KEY = 'pos_status_sound';

const LOOK = {
  green: { shape: '●', cls: 'text-emerald-400' },
  amber: { shape: '▲', cls: 'text-amber-400' },
  red: { shape: '■', cls: 'text-red-400' },
  off: { shape: '○', cls: 'text-[color:var(--pos-fg-muted)]' },
} as const;

function readSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === '1';
  } catch {
    return false;
  }
}

function beep() {
  try {
    const Ctx =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 660;
    g.gain.value = 0.08;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.25);
  } catch {
    // no sound available
  }
}

export const StatusLights = memo(function StatusLights({
  onOpenReviews,
}: {
  /** Admin: open the review list. The till only says where it is. */
  onOpenReviews?: () => void;
}) {
  const { t } = useTranslation();
  const [lights, setLights] = useState<StatusLight[] | null>(null);
  const [reviews, setReviews] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [sound, setSound] = useState(readSound);
  const lastJson = useRef('');
  const prev = useRef<StatusLight[] | null>(null);

  useEffect(() => {
    const read = (window as any).api?.status?.lights;
    if (!read) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      if (document.visibilityState !== 'hidden') {
        try {
          const r = await read();
          if (cancelled || !r) return;
          const json = JSON.stringify([r.lights, r.reviews]);
          if (json !== lastJson.current) {
            lastJson.current = json;
            if (readSound() && newlyRed(prev.current, r.lights).length) beep();
            prev.current = r.lights;
            setLights(r.lights);
            setReviews(Number(r.reviews) || 0);
          }
        } catch {
          // the connection bar says when the till is away
        }
      }
      if (!cancelled) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        window.clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (!lights) return null;
  const current = lights.find((l) => l.key === open) || null;
  return (
    <div
      className="relative flex items-center gap-1"
      data-testid="status-lights"
    >
      {lights.map((l) => (
        <button
          key={l.key}
          type="button"
          data-key={l.key}
          data-level={l.level}
          className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] hover:bg-[var(--pos-hover)]"
          title={`${t(`status.light.${l.key}`)}: ${l.message}`}
          aria-label={`${t(`status.light.${l.key}`)}: ${t(`status.level.${l.level}`)}. ${l.message}`}
          onClick={() => setOpen((o) => (o === l.key ? null : l.key))}
        >
          <span aria-hidden className={LOOK[l.level].cls}>
            {LOOK[l.level].shape}
          </span>
          <span className="hidden text-[color:var(--pos-fg-muted)] md:inline">
            {t(`status.short.${l.key}`)}
          </span>
        </button>
      ))}
      {reviews > 0 ? (
        <button
          type="button"
          data-testid="review-badge"
          className="ml-1 rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white"
          title={t('status.reviewsBadge', { count: reviews })}
          aria-label={t('status.reviewsBadge', { count: reviews })}
          onClick={() => (onOpenReviews ? onOpenReviews() : setOpen('fiscal'))}
        >
          {reviews}
        </button>
      ) : null}
      {current ? (
        <div
          role="dialog"
          aria-label={t(`status.light.${current.key}`)}
          className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-white/10 bg-[var(--pos-surface,#111)] p-3 text-[13px] shadow-xl"
        >
          <div className="font-semibold">
            <span aria-hidden className={LOOK[current.level].cls}>
              {LOOK[current.level].shape}
            </span>{' '}
            {t(`status.light.${current.key}`)} ·{' '}
            {t(`status.level.${current.level}`)}
          </div>
          <div className="mt-1">{current.message}</div>
          {current.details.length ? (
            <ul className="mt-1 list-disc pl-4 text-[12px] text-[color:var(--pos-fg-muted)]">
              {current.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          ) : null}
          {current.fix ? (
            <div className="mt-2 text-[12px]">
              <b>{t('status.whatToDo')}</b> {current.fix}
            </div>
          ) : null}
          {current.key === 'fiscal' && reviews > 0 ? (
            onOpenReviews ? (
              <button
                type="button"
                className="pos-btn mt-2"
                onClick={onOpenReviews}
              >
                {t('status.openReviews', { count: reviews })}
              </button>
            ) : (
              <div className="mt-2 text-[12px]">
                {t('status.reviewsInAdmin')}
              </div>
            )
          ) : null}
          <label className="mt-3 flex items-center gap-2 text-[12px] text-[color:var(--pos-fg-muted)]">
            <input
              type="checkbox"
              checked={sound}
              onChange={(e) => {
                setSound(e.target.checked);
                try {
                  localStorage.setItem(SOUND_KEY, e.target.checked ? '1' : '0');
                } catch {
                  // this device only
                }
              }}
            />
            {t('status.sound')}
          </label>
        </div>
      ) : null}
    </div>
  );
});
