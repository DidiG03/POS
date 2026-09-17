/**
 * Waiter UI must stay tappable after a table tap, and Courses / Seat
 * drag-reorder must not hitch. These source guards encode the regressions
 * that froze Android for ~30s or made the ticket board feel stuck.
 *
 * Behavioral coverage lives next to the code:
 *   - ticketRead.test.ts (cached floor, no second snapshot parse)
 *   - offlineQueueLiveBudget.test.ts (4s live-attempt budget)
 *   - posReadCache.test.ts (same-snapshot ingest is a no-op)
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function sliceBetween(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  const to = src.indexOf(end, from + start.length);
  expect(from, `missing start ${JSON.stringify(start)}`).toBeGreaterThan(-1);
  expect(to, `missing end ${JSON.stringify(end)} after start`).toBeGreaterThan(
    from,
  );
  return src.slice(from, to);
}

describe('waiter UI stays responsive', () => {
  it('does not mount a hidden ticket pane over the phone menu', () => {
    const order = read('src/renderer/app/pages/OrderPage.tsx');
    expect(order).toMatch(/\{showMenuPane \? \(/);
    expect(order).toMatch(/\{showTicketPane \? \(/);
    expect(order).toContain('ORDER_TWO_PANE');
    expect(order).not.toMatch(
      /mobilePane === ['"]ticket['"] \? ['"]flex-1['"] : ['"]hidden['"]/,
    );
    expect(order).not.toMatch(/\bhidden\b[^`'"]{0,80}md:flex/);
    const paneClass = sliceBetween(
      order,
      'pos-ticket-pane',
      'mb-2 shrink-0 space-y-2',
    );
    expect(paneClass).not.toMatch(/(?:^|[\s"'`])hidden(?:[\s"'`]|$)/);
  });

  it('does not await listOpen or table writes on the tap-to-order path', () => {
    const order = read('src/renderer/app/pages/OrderPage.tsx');
    const closed = sliceBetween(
      order,
      'if (!isOpen(selectedTable.area, selectedTable.label)) {',
      'const peeked = peekTableBill',
    );
    expect(closed).toContain('void window.api.tables');
    expect(closed).toContain('.listOpen()');
    expect(closed).not.toMatch(
      /await\s+window\.api\.tables\s*\n?\s*\.listOpen/,
    );
    expect(closed).not.toMatch(/await window\.api\.tables\.listOpen/);

    const ensure = sliceBetween(
      order,
      'const ensureStoreTillOpen = useCallback',
      'const orderPollGenRef',
    );
    expect(ensure).toMatch(/void tryOrQueue\(\s*'tables\.setOpen'/);
    expect(ensure).toMatch(/void tryOrQueue\(\s*'covers\.save'/);
    expect(ensure).not.toMatch(/await tryOrQueue\(\s*'tables\.setOpen'/);
    expect(ensure).not.toMatch(/await tryOrQueue\(\s*'covers\.save'/);
  });

  it('peeks a cached floor snapshot instead of re-parsing it on every table tap', () => {
    const ticketRead = read('src/renderer/utils/ticketRead.ts');
    expect(ticketRead).toContain('peekFloorSnapshot(area)');
    expect(ticketRead).toContain('ingest: false');
    const cached = sliceBetween(
      ticketRead,
      'const cachedFloor = peekFloorSnapshot(area);',
      'if (typeof deps.fetchFloor ===',
    );
    expect(cached).toContain('ingest: false');
    expect(cached).not.toContain('ingestFloorSnapshot(');
  });

  it('hands hung table-state writes to the queue after 4s, not 30s', () => {
    const queue = read('src/renderer/utils/offlineQueue.ts');
    expect(queue).toContain('const LIVE_ATTEMPT_BUDGET_MS = 4_000');
    expect(queue).toContain("['tables.setOpen', 'covers.save']");
    expect(queue).toContain('function raceLiveAttempt');
  });

  it('keeps the open-table clock off the OrderPage render path', () => {
    const order = read('src/renderer/app/pages/OrderPage.tsx');
    const page = sliceBetween(
      order,
      'export default function OrderPage()',
      'function formatElapsed',
    );
    expect(page).not.toMatch(/setInterval\s*\(/);
    expect(page).not.toContain('setNowMs');
    expect(page).toContain('<OpenTableElapsed');
    expect(order).toContain('function OpenTableElapsed');
    expect(order).toContain("from '../components/TicketLineRow'");
    const row = read('src/renderer/app/components/TicketLineRow.tsx');
    expect(row).toContain('export const TicketLineRow = memo(');
  });

  it('preloads the course board when the ticket pane is shown, without a static dnd import', () => {
    const order = read('src/renderer/app/pages/OrderPage.tsx');
    expect(order).not.toMatch(
      /from ['"]\.\.\/components\/TicketCourseBoard['"]/,
    );
    expect(order).toContain("import('../components/TicketCourseBoard')");
    expect(order).toContain('void loadTicketCourseBoard()');
    const preload = sliceBetween(
      order,
      "useEffect(() => {\n    if (!(twoPane || mobilePane === 'ticket')) return;",
      'const [showTransfer, setShowTransfer]',
    );
    expect(preload).toContain('void loadTicketCourseBoard()');
  });

  it('switches course/seat in one store update and uses a cheap drag layer', () => {
    const ticket = read('src/renderer/stores/ticket.ts');
    const setAdd = sliceBetween(
      ticket,
      'setAddMode: (mode) => {',
      'bindTable:',
    );
    expect(setAdd).toContain('...appliedCourseLayout(s)');
    expect(setAdd).toContain('...appliedSeatLayout(s)');
    expect(setAdd).not.toContain('ensureCourses');
    expect(setAdd).not.toContain('ensureSeats');
    expect(setAdd).not.toMatch(/set\(\{\s*addMode: next\s*\}\)/);

    const board = read('src/renderer/app/components/TicketCourseBoard.tsx');
    expect(board).toMatch(/collisionDetection=\{closestCenter\}/);
    expect(board).not.toContain('closestCorners');
    expect(board).not.toContain('DragOverlay');
    expect(board).toContain('MeasuringStrategy.BeforeDragging');
    expect(board).toContain('touch-none');
    expect(board).toContain('export const TicketCourseBoard = memo(');
    expect(board).toContain('layoutShiftCompensation: false');
  });

  it('paints the floor from the layout cache instead of waiting on a 10s GET', () => {
    const floor = read('src/renderer/app/components/FloorCanvas.tsx');
    expect(floor).toContain('nodesFromCachedLayout');
    expect(floor).toContain('peekLayout');
    expect(floor).toContain('readLayout');
    expect(floor).not.toMatch(
      /setLayoutFailed\(false\);\s*setSaveError\(null\);\s*setNodes\(null\)/,
    );
    const cache = read('src/renderer/utils/posReadCache.ts');
    expect(cache).toContain('POS_CACHE.layout');
    expect(cache).toContain('function readLayout');
    expect(cache).toContain('void readLayout(name)');
    expect(read('src/main/index.ts')).toContain('key: { endsWith: suffix }');
    expect(read('src/main/api.ts')).toContain('key: { endsWith: suffix }');
  });
});
