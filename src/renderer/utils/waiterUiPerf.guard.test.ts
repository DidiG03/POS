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
    expect(floor).toContain('useLayoutEffect');
    expect(floor).toContain('isFloorCanvasFitReady');
    expect(floor).toContain('lastMeasuredCanvasSize');
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

  it('does not hold Send on kitchen TCP — print is fire-and-forget after the order is logged', () => {
    const order = read('src/renderer/app/pages/OrderPage.tsx');
    const fire = sliceBetween(
      order,
      'const runKitchenFire = useCallback',
      'const printSeatBill = useCallback',
    );
    expect(fire).toMatch(/void printTicket\(/);
    expect(fire).not.toMatch(/await printTicket\(/);
    expect(order).toContain('const LIVE_TICKET_BUDGET_MS = 2_000');
    expect(order).toContain('function raceWithBudget');
  });

  it('answers kitchen /print/ticket without waiting for the printers', () => {
    const dispatcher = read('src/main/services/printDispatcher.ts');
    expect(dispatcher).toContain('export function fireDispatchTicket');
    expect(dispatcher).toContain(
      'export function paymentPrintWaitsForPrinters',
    );
    expect(dispatcher).toContain('await Promise.all(');

    const lan = read('src/main/api.ts');
    const printRoute = sliceBetween(
      lan,
      "pathname === '/print/ticket'",
      "pathname === '/tickets/void-item'",
    );
    expect(printRoute).toContain('fireDispatchTicket(');
    expect(printRoute).toContain('paymentPrintWaitsForPrinters(payKind)');
    expect(printRoute).not.toMatch(
      /await dispatchTicket\([\s\S]*return send\(\s*res,\s*r\.ok \? 200 : 500/,
    );

    const ipc = read('src/main/index.ts');
    const ipcPrint = sliceBetween(
      ipc,
      "ipcHandle('tickets:print'",
      "ipcHandle('reports:listMyActiveTickets'",
    );
    expect(ipcPrint).toContain('fireDispatchTicket(');
    expect(ipcPrint).toContain('paymentPrintWaitsForPrinters(kind)');
  });

  it('does not retry aborted POSTs and skips PIN-screen staff polling', () => {
    const lan = read('src/renderer/browserLanApi.ts');
    expect(lan).toContain("mutating && name === 'AbortError'");
    expect(lan).toContain('lastSseDataAt');
    expect(lan).toContain('if (missedMs > 8_000) emitPosSyncCatchupSoon()');

    const login = read('src/renderer/app/pages/LoginPage.tsx');
    expect(login).not.toMatch(/setInterval\(\(\)\s*=>[\s\S]{0,80}refreshStaff/);
    expect(login).toContain('pos:usersChanged');

    expect(read('src/renderer/utils/posReadCache.ts')).toContain(
      'const CATCHUP_DEBOUNCE_MS = 8_000',
    );
    expect(read('src/renderer/utils/offlineQueue.ts')).toContain(
      'const FAILED_MAX_ITEMS = 80',
    );
  });

  it('does not resubscribe OrderPage or TablesPage to the whole ticket store', () => {
    const order = read('src/renderer/app/pages/OrderPage.tsx');
    expect(order).toContain("from 'zustand/react/shallow'");
    expect(order).toContain('useShallow((s) => ({');
    expect(order).not.toMatch(/\} = useTicketStore\(\);/);
    expect(order).toContain('ownerIdFromFloorCache');
    expect(order).toMatch(/void tryOrQueue\(\s*'tickets.voidItem'/);

    const tables = read('src/renderer/app/pages/TablesPage.tsx');
    expect(tables).toContain('useTicketStore((s) => s.hydrate)');
    expect(tables).toContain('useTicketStore((s) => s.bindTable)');
    expect(tables).not.toMatch(
      /const \{ hydrate, bindTable \} = useTicketStore\(\)/,
    );
  });

  it('keeps floor occupancy payloads free of ticket lines', () => {
    const floor = read('src/main/services/floorSnapshot.ts');
    expect(floor).toContain('items: []');
    expect(floor).not.toMatch(/total: ticketRunningTotal\(items\),\s*items,/);

    const lan = read('src/main/api.ts');
    expect(lan).toContain('function sendJson');
    expect(lan).toContain('If-None-Match');
    expect(lan).toContain('{ etag: true }');

    const client = read('src/renderer/browserLanApi.ts');
    expect(client).toContain("headers['If-None-Match']");
    expect(client).toContain('r.status === 304');

    expect(read('src/renderer/utils/swrCache.ts')).toContain(
      "return !key.startsWith('pos:floor:')",
    );
  });

  it('loads the open-table bill by id, not mixed createdAt', () => {
    const src = read('src/main/services/tableSession.ts');
    expect(src).toContain('pickLatestSessionTicket');
    expect(src).toContain("orderBy: { id: 'desc' }");
    expect(src).not.toMatch(
      /findLatestTicketLogSince[\s\S]{0,400}orderBy: \{ createdAt: 'desc' \}/,
    );
  });

  it('does not run a 1s clock per waiter order card', () => {
    const src = read('src/renderer/app/pages/WaiterOrdersPage.tsx');
    expect(src).toContain('const OrderCard = memo(');
    expect(src).toContain('clockMs');
    expect(src).toContain('boardPollMs');
    expect(src).not.toMatch(
      /function OrderCard\([\s\S]{0,400}setInterval\(\(\) => setClockMs/,
    );
    expect(read('src/main/services/kdsList.ts')).toContain(
      'const floor = await getFloorSnapshot()',
    );
  });

  it('memoizes menu tiles so adding a line does not rebuild the grid', () => {
    const order = read('src/renderer/app/pages/OrderPage.tsx');
    expect(order).toContain('const MenuItemTile = memo(');
    expect(order).toContain('<MenuItemTile');
    expect(order).toContain('showQtyBubble={!twoPane}');
    expect(order).toContain('pos-menu-qty');
    expect(read('src/renderer/styles/index.css')).toContain('.pos-menu-qty');
    // After Send, remaining bill lines stay on the ticket. Bubbles must
    // count only staged (unsent) qty so waiters are not shown last round.
    const qtyBySku = sliceBetween(
      order,
      'const qtyBySku = useMemo',
      'const ticketFullySettled',
    );
    expect(qtyBySku).toContain('if (l.staged !== true) continue;');
    expect(order).toContain('pos-menu-cat-dot');
    expect(order).toContain('tabColor || FALLBACK_TILE_BG');
    expect(order).not.toMatch(/\{tabColor \? \(/);
    expect(read('src/renderer/styles/index.css')).toContain(
      'contain-intrinsic-size: auto 5.75rem',
    );
    expect(read('src/renderer/styles/index.css')).toContain(
      '.pos-menu-cat-dot',
    );
  });

  it('keeps other waiters floor caches and boards off one Send', () => {
    const sync = read('src/renderer/utils/posRealtimeSync.ts');
    const tickets = sliceBetween(
      sync,
      "eventName === 'pos:ticketsChanged'",
      "eventName === 'pos:tablesChanged'",
    );
    expect(tickets).toContain('applyLiveTableEvent');
    expect(tickets).not.toContain('invalidateFloorSnapshots');
    expect(tickets).not.toContain('invalidateFloorCache');

    const tablesPage = read('src/renderer/app/pages/TablesPage.tsx');
    const onTickets = sliceBetween(
      tablesPage,
      'const onTicketsChanged = (ev: any) => {',
      "window.addEventListener('pos:ticketsChanged', onTicketsChanged);",
    );
    expect(onTickets).not.toContain('readFloorSnapshot');
    expect(onTickets).not.toContain('refresh()');
    expect(onTickets).toContain('paintFromCache');

    const waiter = read('src/renderer/app/pages/WaiterOrdersPage.tsx');
    expect(waiter).toContain('waiterUserId');
    expect(waiter).toContain('uid !== Number(waiterUserId)');
    expect(waiter).toContain('sseTimer');

    const ipcLog = sliceBetween(
      read('src/main/index.ts'),
      "ipcHandle('tickets:log'",
      "ipcHandle('tickets:getLatestForTable'",
    );
    expect(ipcLog).not.toContain('expireStaleMenuStock');
    expect(ipcLog).toContain('void compactTicketLogSession');
    expect(ipcLog).toContain('void (async () => {');

    const lanLog = sliceBetween(
      read('src/main/api.ts'),
      "pathname === '/tickets'",
      "pathname === '/tickets/latest'",
    );
    expect(lanLog).toContain('void compactTicketLogSession');
    expect(lanLog).toContain('void createKdsTicketFromLog');
    expect(lanLog).not.toMatch(/await compactTicketLogSession/);
    expect(lanLog).not.toMatch(/await createKdsTicketFromLog/);
  });

  it('puts phone notifications on a tab instead of overlaying Tables', () => {
    const layout = read('src/renderer/app/AppLayout.tsx');
    expect(layout).toContain("to: '/app/notifications'");
    expect(layout).toContain('pos-mobile-tabbar');
    expect(layout).toContain('relative hidden sm:inline-block');
    expect(layout).not.toContain("from '../components/NotificationsPanel'");
    expect(read('src/renderer/routes.tsx')).toContain("path: 'notifications'");
    expect(read('src/renderer/app/pages/NotificationsPage.tsx')).toContain(
      'NotificationsInbox',
    );
  });
});
