import { describe, expect, it } from 'vitest';
import { paginateTicketBlocks } from './kdsPagination';

describe('paginateTicketBlocks', () => {
  it('returns one page when everything fits in the columns', () => {
    // 4 columns × 1000px. Six 300px tickets = 1800px total < 4000px budget.
    const tickets = Array.from({ length: 6 }, () => [300]);
    const pages = paginateTicketBlocks(tickets, 4, 1000);
    expect(pages.length).toBe(1);
    expect(pages[0]).toHaveLength(6);
  });

  it('fills every column before breaking to a new page', () => {
    // 2 columns × 1000px = 2000px budget. Ten 250px tickets = 2500px.
    // First page should hold 8 (2000px), continuing into the 2nd column —
    // not break early while a column still has room.
    const tickets = Array.from({ length: 10 }, () => [250]);
    const pages = paginateTicketBlocks(tickets, 2, 1000);
    expect(pages[0]).toHaveLength(8);
    expect(pages[1]).toHaveLength(2);
  });

  it('lets a ticket continue across a column boundary (no wasted gap)', () => {
    // 2 columns × 100px. A ticket split into 3×40px blocks flows: col0 gets
    // two blocks (80px), col1 gets the third — so two such tickets (6 blocks,
    // 240px) need 3 columns → only the first 2 columns fit on page 1.
    const tickets = [
      [40, 40, 40],
      [40, 40, 40],
    ];
    const pages = paginateTicketBlocks(tickets, 2, 100);
    // Ticket 0 occupies col0 (80) + col1 (40 -> ends at 40). Ticket 1 placed
    // from col1@40: 40 fits (80), next 40 -> col2 (overflow) => 3 cols => new page.
    expect(pages).toHaveLength(2);
    expect(pages[0]).toEqual([0]);
    expect(pages[1]).toEqual([1]);
  });

  it('never drops a ticket taller than a full page', () => {
    const tickets = [[5000]]; // taller than 4 × 1000
    const pages = paginateTicketBlocks(tickets, 4, 1000);
    expect(pages.flat()).toEqual([0]);
  });

  it('handles empty input', () => {
    expect(paginateTicketBlocks([], 4, 1000)).toEqual([]);
  });
});
