/** Lines containing transfer audit tags — not waiter order notes. */
const TRANSFER_NOTE_LINE = /\[TRANSFER/i;

export function stripTransferTagsFromNote(
  note: string | null | undefined,
): string {
  const lines = String(note || '').split('\n');
  const kept = lines.filter((line) => !TRANSFER_NOTE_LINE.test(line));
  return kept.join('\n').trim();
}

export function buildTransferTicketNote(
  transferTag: string,
  existingNote: string | null | undefined,
): string {
  const userNote = stripTransferTagsFromNote(existingNote);
  const tag = String(transferTag || '').trim();
  if (!tag) return userNote;
  return userNote ? `${tag}\n${userNote}` : tag;
}
