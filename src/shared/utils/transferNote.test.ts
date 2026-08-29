import { describe, expect, it } from 'vitest';
import {
  buildTransferTicketNote,
  describeTicketNote,
  extractTransferTagLines,
  formatTransferTagLine,
  stripTransferTagsFromNote,
} from './transferNote';

describe('buildTransferTicketNote', () => {
  it('keeps the waiter note under a new transfer tag', () => {
    expect(
      buildTransferTicketNote(
        '[TRANSFER DidiG03 → Sefrid Kapllani]',
        'no onions',
      ),
    ).toBe('[TRANSFER DidiG03 → Sefrid Kapllani]\nno onions');
  });

  it('stacks waiter then table so the full chain stays on the ticket', () => {
    const afterWaiter = buildTransferTicketNote(
      '[TRANSFER DidiG03 → Sefrid Kapllani]',
      'no onions',
    );
    const afterTable = buildTransferTicketNote(
      '[TRANSFER from Salla T1 → Veranda T2]',
      afterWaiter,
    );
    expect(afterTable).toBe(
      [
        '[TRANSFER from Salla T1 → Veranda T2]',
        '[TRANSFER DidiG03 → Sefrid Kapllani]',
        'no onions',
      ].join('\n'),
    );
  });

  it('does not copy moved-out tags onto the destination ticket', () => {
    const next = buildTransferTicketNote(
      '[TRANSFER from Salla T1 → Veranda T2]',
      '[TRANSFER moved-out → Veranda T2]\n[TRANSFER DidiG03 → Sefrid Kapllani]',
    );
    expect(next).toBe(
      [
        '[TRANSFER from Salla T1 → Veranda T2]',
        '[TRANSFER DidiG03 → Sefrid Kapllani]',
      ].join('\n'),
    );
    expect(next).not.toMatch(/moved-out/i);
  });
});

describe('extractTransferTagLines / stripTransferTagsFromNote', () => {
  it('splits audit tags from the waiter note', () => {
    const note = [
      '[TRANSFER from Salla T1 → Veranda T2]',
      '[TRANSFER DidiG03 → Sefrid Kapllani]',
      'no onions',
    ].join('\n');
    expect(extractTransferTagLines(note)).toEqual([
      '[TRANSFER from Salla T1 → Veranda T2]',
      '[TRANSFER DidiG03 → Sefrid Kapllani]',
    ]);
    expect(stripTransferTagsFromNote(note)).toBe('no onions');
  });
});

describe('formatTransferTagLine', () => {
  it('formats a waiter handoff', () => {
    expect(formatTransferTagLine('[TRANSFER DidiG03 → Sefrid Kapllani]')).toBe(
      'Waiter: DidiG03 → Sefrid Kapllani',
    );
  });

  it('formats a table move with destination', () => {
    expect(formatTransferTagLine('[TRANSFER from Salla T1 → Veranda T2]')).toBe(
      'Table: Salla T1 → Veranda T2',
    );
  });

  it('formats a table move that also names the new waiter', () => {
    expect(
      formatTransferTagLine(
        '[TRANSFER from Salla T1 → Veranda T2 · now Sefrid Kapllani]',
      ),
    ).toBe('Table: Salla T1 → Veranda T2 · waiter Sefrid Kapllani');
  });
});

describe('describeTicketNote', () => {
  it('returns formatted history plus the waiter note', () => {
    const out = describeTicketNote(
      [
        '[TRANSFER from Salla T1 → Veranda T2]',
        '[TRANSFER DidiG03 → Sefrid Kapllani]',
        'no onions',
      ].join('\n'),
    );
    expect(out.history).toEqual([
      'Table: Salla T1 → Veranda T2',
      'Waiter: DidiG03 → Sefrid Kapllani',
    ]);
    expect(out.userNote).toBe('no onions');
  });
});
