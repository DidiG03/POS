import { create } from 'zustand';

export type ToastLevel = 'error' | 'warn' | 'info' | 'success';

export type Toast = {
  id: string;
  level: ToastLevel;
  title?: string;
  message: string;
  detail?: string;
  createdAt: number;
  timeoutMs: number | null;
};

type PushToastInput = {
  level: ToastLevel;
  title?: string;
  message: string;
  detail?: string;
  timeoutMs?: number | null;
};

interface ToastState {
  toasts: Toast[];
  push: (t: PushToastInput) => string;
  remove: (id: string) => void;
  clear: () => void;
}

const timers = new Map<string, number>();

function genId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function defaultTimeoutMs(level: ToastLevel): number {
  if (level === 'error') return 12_000;
  if (level === 'warn') return 10_000;
  return 6_000;
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = genId();
    const createdAt = Date.now();
    const timeoutMs =
      typeof t.timeoutMs === 'undefined' ? defaultTimeoutMs(t.level) : t.timeoutMs;

    set((s) => {
      const next: Toast = {
        id,
        level: t.level,
        title: t.title,
        message: t.message,
        detail: t.detail,
        createdAt,
        timeoutMs: timeoutMs ?? null,
      };
      // Keep newest first, cap to avoid infinite growth.
      const toasts = [next, ...s.toasts].slice(0, 5);
      return { toasts };
    });

    if (timeoutMs != null) {
      const existing = timers.get(id);
      if (existing) window.clearTimeout(existing);
      const timer = window.setTimeout(() => {
        get().remove(id);
      }, Math.max(250, timeoutMs));
      timers.set(id, timer);
    }

    return id;
  },
  remove: (id) => {
    const t = timers.get(id);
    if (t) window.clearTimeout(t);
    timers.delete(id);
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
  },
  clear: () => {
    for (const t of timers.values()) window.clearTimeout(t);
    timers.clear();
    set({ toasts: [] });
  },
}));

function normalizeErrorDetail(e: unknown): string | undefined {
  if (!e) return undefined;
  if (typeof e === 'string') return e;
  const anyE = e as any;
  const msg = anyE?.message ? String(anyE.message) : '';
  const stack = anyE?.stack ? String(anyE.stack) : '';
  const out = [msg, stack].filter(Boolean).join('\n');
  return out || undefined;
}

export const toast = {
  error(message: string, opts?: { title?: string; detail?: string; timeoutMs?: number | null }) {
    useToastStore.getState().push({
      level: 'error',
      title: opts?.title ?? 'Error',
      message,
      detail: opts?.detail,
      timeoutMs: opts?.timeoutMs,
    });
  },
  warn(message: string, opts?: { title?: string; detail?: string; timeoutMs?: number | null }) {
    useToastStore.getState().push({
      level: 'warn',
      title: opts?.title ?? 'Warning',
      message,
      detail: opts?.detail,
      timeoutMs: opts?.timeoutMs,
    });
  },
  info(message: string, opts?: { title?: string; detail?: string; timeoutMs?: number | null }) {
    useToastStore.getState().push({
      level: 'info',
      title: opts?.title ?? 'Info',
      message,
      detail: opts?.detail,
      timeoutMs: opts?.timeoutMs,
    });
  },
  success(message: string, opts?: { title?: string; detail?: string; timeoutMs?: number | null }) {
    useToastStore.getState().push({
      level: 'success',
      title: opts?.title ?? 'Success',
      message,
      detail: opts?.detail,
      timeoutMs: opts?.timeoutMs,
    });
  },
  fromError(
    e: unknown,
    fallbackMessage: string,
    opts?: { title?: string; timeoutMs?: number | null },
  ) {
    const detail = normalizeErrorDetail(e);
    const message =
      typeof (e as any)?.message === 'string' && String((e as any).message).trim()
        ? String((e as any).message).trim()
        : fallbackMessage;
    useToastStore.getState().push({
      level: 'error',
      title: opts?.title ?? 'Error',
      message,
      detail,
      timeoutMs: opts?.timeoutMs,
    });
  },
};

