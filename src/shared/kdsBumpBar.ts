export type KdsBumpBarAction =
  | { type: 'bumpSlot'; slot: number }
  | { type: 'bumpSelected' }
  | { type: 'recall' }
  | { type: 'recallSelected' }
  | { type: 'selectNext' }
  | { type: 'selectPrev' }
  | { type: 'selectItemNext' }
  | { type: 'selectItemPrev' }
  | { type: 'selectFirst' }
  | { type: 'showDone' }
  | { type: 'showNew' }
  | { type: 'showSettings' }
  | { type: 'clearDone' }
  | { type: 'scrollUp' }
  | { type: 'scrollDown' }
  | { type: 'showTicketSummary' }
  | { type: 'dismiss' };

export type KdsBumpBarKeyInput = {
  key: string;
  code: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
};

function isLetter(code: string, letter: string) {
  return code === `Key${letter.toUpperCase()}`;
}

function digitFromKeyInput(key: string, code: string): number | null {
  if (/^\d$/.test(key)) return Number(key);
  const d = code.match(/^Digit(\d)$/) || code.match(/^Numpad(\d)$/);
  return d ? Number(d[1]) : null;
}

function bumpSlotFromCode(code: string): number | null {
  const fn = code.match(/^F(\d+)$/);
  if (fn) {
    const n = Number(fn[1]);
    if (n >= 2 && n <= 3) return n - 1;
    if (n === 5) return 3;
  }

  const pad = code.match(/^Numpad(\d+)$/);
  if (pad) {
    const n = Number(pad[1]);
    if (n >= 2 && n <= 3) return n - 1;
    if (n === 5) return 3;
  }

  return null;
}

/** Map a key (browser or Electron before-input-event) to a KDS bump-bar action. */
export function kdsBumpBarActionFromKeyInput(
  input: KdsBumpBarKeyInput,
): KdsBumpBarAction | null {
  if (input.ctrlKey || input.metaKey || input.altKey) return null;

  const key = input.key;
  const code = input.code;
  const digit = digitFromKeyInput(key, code);

  if (key === 'Escape') return { type: 'dismiss' };

  if (digit === 1 || code === 'Numpad1') return { type: 'bumpSelected' };

  if (digit === 0 || code === 'Numpad0') return { type: 'recallSelected' };

  if (digit === 7 || code === 'Numpad7') return { type: 'selectItemPrev' };

  if (isLetter(code, 'g') || key === 'g' || key === 'G') {
    return { type: 'selectItemNext' };
  }

  if (digit === 6 || code === 'Numpad6') return { type: 'showNew' };

  if (isLetter(code, 'f') || key === 'f' || key === 'F') {
    return { type: 'showDone' };
  }

  if (isLetter(code, 'j') || key === 'j' || key === 'J') {
    return { type: 'showSettings' };
  }

  if (isLetter(code, 'a') || key === 'a' || key === 'A') {
    return { type: 'showTicketSummary' };
  }

  if (digit === 4 || code === 'Numpad4') return { type: 'clearDone' };

  // Ticket slots (handler uses list[action.slot - 1]).
  if (digit === 2) return { type: 'bumpSlot', slot: 1 };
  if (digit === 3) return { type: 'bumpSlot', slot: 2 };
  if (digit === 5) return { type: 'bumpSlot', slot: 3 };

  const slotFromCode = bumpSlotFromCode(code);
  if (slotFromCode != null) return { type: 'bumpSlot', slot: slotFromCode };

  if (key === 'Enter' || key === 'End') return { type: 'bumpSelected' };

  if (
    isLetter(code, 'r') ||
    key === 'r' ||
    key === 'R' ||
    key === 'Insert' ||
    code === 'NumpadSubtract'
  ) {
    return { type: 'recall' };
  }

  if (key === 'Home') return { type: 'selectFirst' };

  if (key === 'ArrowUp') return { type: 'scrollUp' };

  if (digit === 8 || code === 'Numpad8') return { type: 'selectPrev' };

  if (isLetter(code, 'h') || key === 'h' || key === 'H') {
    return { type: 'selectNext' };
  }

  if (key === 'Tab' || isLetter(code, 'n') || key === 'n' || key === 'N') {
    return { type: 'selectNext' };
  }

  if (key === 'ArrowDown') return { type: 'scrollDown' };

  if (key === 'PageUp') return { type: 'scrollUp' };

  if (key === 'PageDown') return { type: 'scrollDown' };

  if (isLetter(code, 's') || key === 's' || key === 'S') {
    return { type: 'showDone' };
  }
  if (key === 'F7') return { type: 'showNew' };

  return null;
}

export function kdsBumpBarActionFromEvent(
  e: KeyboardEvent,
): KdsBumpBarAction | null {
  return kdsBumpBarActionFromKeyInput({
    key: e.key,
    code: e.code,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
  });
}

export const KDS_BUMP_BAR_PROGRAMMING = [
  {
    button: '1',
    keystroke: '1',
    action: 'Bump whole ticket, or selected item if one is highlighted',
  },
  { button: '2', keystroke: '2', action: 'Bump ticket #1 (top-left)' },
  { button: '3', keystroke: '3', action: 'Bump ticket #2' },
  { button: '4', keystroke: '4', action: 'Clear Done tab (current station)' },
  { button: '5', keystroke: '5', action: 'Bump ticket #4' },
  { button: '6', keystroke: '6', action: 'Switch to NEW tab' },
  { button: '7', keystroke: '7', action: 'Previous item on selected ticket' },
  { button: '8', keystroke: '8', action: 'Previous ticket' },
  { button: 'Item ↓', keystroke: 'G', action: 'Next item on selected ticket' },
  { button: 'Ticket ↓', keystroke: 'H', action: 'Next ticket (in order)' },
  {
    button: '0',
    keystroke: '0',
    action: 'Recall selected ticket or item (Done tab)',
  },
  { button: 'Recall', keystroke: 'R', action: 'Recall last bumped ticket' },
  {
    button: 'Home',
    keystroke: 'Home',
    action: 'Select first ticket (NEW tab)',
  },
  { button: 'End', keystroke: 'End', action: 'Bump selected ticket' },
  { button: 'Next', keystroke: 'N', action: 'Select next ticket' },
  { button: 'Cursor ↑', keystroke: '↑', action: 'Scroll ticket list up' },
  { button: 'Cursor ↓', keystroke: '↓', action: 'Scroll ticket list down' },
  { button: 'Done', keystroke: 'F', action: 'Switch to Done tab' },
  {
    button: 'Settings',
    keystroke: 'J',
    action: 'Open Settings tab',
  },
  {
    button: 'All items',
    keystroke: 'A',
    action: 'Show / hide full ticket (all stations)',
  },
  {
    button: 'Item Summary',
    keystroke: 'S',
    action: 'Switch to Done tab (legacy)',
  },
  {
    button: 'Bump (list ↓)',
    keystroke: 'Enter',
    action: 'Bump selected ticket',
  },
] as const;
