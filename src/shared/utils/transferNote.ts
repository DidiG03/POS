/** Lines containing transfer audit tags — not waiter order notes. */
const TRANSFER_NOTE_LINE = /\[TRANSFER/i;
const MOVED_OUT_LINE = /\[TRANSFER\s+moved-out/i;

function noteLines(note: string | null | undefined): string[] {
  return String(note || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isMovedOutLine(line: string): boolean {
  return MOVED_OUT_LINE.test(line);
}

/**
 * Remove transfer audit markers from a ticket note so the order-notes field
 * only shows what the waiter typed (allergies, instructions, etc.).
 */
export function stripTransferTagsFromNote(
  note: string | null | undefined,
): string {
  const kept = noteLines(note).filter((line) => !TRANSFER_NOTE_LINE.test(line));
  return kept.join('\n').trim();
}

/** Audit tags that belong on the live ticket (not source-session moved-out). */
export function extractTransferTagLines(
  note: string | null | undefined,
): string[] {
  return noteLines(note).filter(
    (line) => TRANSFER_NOTE_LINE.test(line) && !isMovedOutLine(line),
  );
}

/**
 * Build the persisted ticket note for a transfer: keep the full chain of
 * waiter/table moves, drop moved-out markers, and leave the waiter's own
 * note at the bottom.
 */
export function buildTransferTicketNote(
  transferTag: string,
  existingNote: string | null | undefined,
): string {
  const userNote = stripTransferTagsFromNote(existingNote);
  const tag = String(transferTag || '').trim();
  const prior = extractTransferTagLines(existingNote);
  const tags = tag ? [tag, ...prior.filter((line) => line !== tag)] : prior;
  return [...tags, userNote].filter(Boolean).join('\n');
}

/** Turn a raw `[TRANSFER …]` line into a short admin-facing sentence. */
export function formatTransferTagLine(line: string): string {
  const s = String(line || '').trim();
  if (!s) return '';
  const inner = s
    .replace(/^\[TRANSFER\s*/i, '')
    .replace(/\]\s*$/, '')
    .trim();
  if (!inner) return s;

  if (/^moved-out\b/i.test(inner)) {
    const dest = inner.replace(/^moved-out\s*(?:→|->)\s*/i, '').trim();
    return dest ? `Moved out → ${dest}` : 'Moved out';
  }

  if (/^from\s+/i.test(inner)) {
    const rest = inner.replace(/^from\s+/i, '').trim();
    const nowParts = rest.split(/\s*·\s*now\s+/);
    const loc = (nowParts[0] || '').trim();
    const waiter = nowParts[1]?.trim();
    const hop = loc.split(/\s*(?:→|->)\s+/);
    const tableBit =
      hop.length >= 2
        ? `Table: ${hop[0].trim()} → ${hop.slice(1).join(' → ').trim()}`
        : `Table from ${loc}`;
    return waiter ? `${tableBit} · waiter ${waiter}` : tableBit;
  }

  const owner = inner.match(/^(.+?)\s*(?:→|->)\s*(.+)$/);
  if (owner && !/^from\s+/i.test(owner[1]) && !/^owner\b/i.test(owner[1])) {
    return `Waiter: ${owner[1].trim()} → ${owner[2].trim()}`;
  }

  return inner;
}

export function describeTicketNote(note: string | null | undefined): {
  history: string[];
  userNote: string;
} {
  return {
    history: extractTransferTagLines(note).map(formatTransferTagLine),
    userNote: stripTransferTagsFromNote(note),
  };
}
