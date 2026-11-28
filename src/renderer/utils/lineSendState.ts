/**
 * What happened to one order line, for the small icon beside it:
 *
 *   NOT_SENT    on this phone only, not sent yet (a draft);
 *   QUEUED      Send was pressed with the till out of reach: saved on this
 *               phone and sent by itself when the till answers;
 *   SENDING     on its way now;
 *   SENT        the till has it;
 *   IN_KITCHEN  on the kitchen display;
 *   DONE        bumped by the kitchen.
 *
 * Paid and voided lines keep their own labels (null here).
 */
export type LineSendState =
  | 'NOT_SENT'
  | 'QUEUED'
  | 'SENDING'
  | 'SENT'
  | 'IN_KITCHEN'
  | 'DONE';

export function lineSendState(
  line: {
    id: string;
    staged?: boolean;
    pending?: boolean;
    voided?: boolean;
    paid?: boolean;
  },
  ctx: {
    /** A Send of this table's lines is in flight (live or the queue's replay). */
    sending: boolean;
    /** Per bill line id, from the till (`tickets.lineStatus`). */
    kitchen?: Record<string, 'IN_KITCHEN' | 'DONE'> | null;
  },
): LineSendState | null {
  if (line.voided || line.paid) return null;
  if (line.pending) return ctx.sending ? 'SENDING' : 'QUEUED';
  if (line.staged) return ctx.sending ? 'SENDING' : 'NOT_SENT';
  const k = ctx.kitchen?.[line.id];
  if (k === 'DONE') return 'DONE';
  if (k === 'IN_KITCHEN') return 'IN_KITCHEN';
  return 'SENT';
}

/**
 * Icon and colour token per state. Shape and text, not colour alone, tell
 * the states apart (colour-blind staff).
 */
export const LINE_STATE_LOOK: Record<
  LineSendState,
  { icon: string; tone: 'muted' | 'amber' | 'sky' | 'green' }
> = {
  NOT_SENT: { icon: '○', tone: 'muted' },
  QUEUED: { icon: '⏸', tone: 'amber' },
  SENDING: { icon: '↻', tone: 'sky' },
  SENT: { icon: '✓', tone: 'green' },
  IN_KITCHEN: { icon: '🔥', tone: 'amber' },
  DONE: { icon: '✓✓', tone: 'green' },
};

/** The connection bar: hidden, offline, sending, or a brief "all sent". */
export type ConnectionBar =
  | { kind: 'hidden' }
  | { kind: 'offline'; waiting: number }
  | { kind: 'sending'; waiting: number }
  | { kind: 'allSent' };

export function connectionBar(input: {
  tillDown: boolean;
  waiting: number;
  syncing: boolean;
  /** When the queue last went from waiting to empty, or 0. */
  emptiedAt: number;
  now: number;
}): ConnectionBar {
  if (input.tillDown) return { kind: 'offline', waiting: input.waiting };
  if (input.waiting > 0) return { kind: 'sending', waiting: input.waiting };
  if (input.emptiedAt && input.now - input.emptiedAt < ALL_SENT_SHOW_MS) {
    return { kind: 'allSent' };
  }
  return { kind: 'hidden' };
}

export const ALL_SENT_SHOW_MS = 3_000;
