/**
 * Bumping a kitchen card or one of its lines, for the till's own KDS window
 * (IPC) and for kitchen displays on the LAN.
 *
 * A bump reads the card's lines, marks some bumped and writes them back.
 * That read and write used to run outside a transaction, so a Send that
 * added lines to the card, or a void that struck one, landing in between
 * was overwritten: the new dish vanished from the kitchen, or a voided dish
 * came back to be cooked. Both now run in one transaction (the database
 * client serialises transactions with every other write).
 *
 * A bump is idempotent: bumping a card that is already done (a second
 * screen on the same station, a bump bar repeating) answers `ok`.
 */
import { prisma } from '@db/client';
import {
  bumpReadyKitchenItems,
  cookerBumpAllKitchenItems,
  cookerBumpSingleKitchenItem,
  isTwoStageKitchen,
} from '@shared/kdsCooker';
import { notifyKdsTicketChanged } from './kdsList';
import { bumpAllStationItemsInJson } from './kdsRecall';

/** KITCHEN always runs the cook → pass flow (no longer a setting). */
const COOKER_ENABLED = true;

export type KdsBumpOutcome = 'ok' | 'not-found' | 'invalid' | 'locked';

function onStation(it: any, station: string): boolean {
  return String(it?.station || '').toUpperCase() === station;
}

function liveOnStation(items: any[], station: string): boolean {
  return items.some(
    (it) => onStation(it, station) && !it?.voided && !it?.bumped,
  );
}

async function completeStation(
  tx: any,
  ticketId: number,
  station: string,
  now: Date,
  bumpedById: number | null,
): Promise<void> {
  await tx.kdsTicketStation.updateMany({
    where: { ticketId, station, status: 'NEW' },
    data: {
      status: 'DONE',
      bumpedAt: now,
      ...(bumpedById ? { bumpedById } : {}),
    },
  });
}

async function safeUserId(tx: any, userId: unknown): Promise<number | null> {
  const id = Number(userId || 0);
  if (!Number.isFinite(id) || id <= 0) return null;
  const u = await tx.user.findUnique({ where: { id } }).catch(() => null);
  return u ? id : null;
}

/** Bump every line of `station` on one card (whole-card bump). */
export async function bumpKdsTicket(input: {
  ticketId: unknown;
  station: unknown;
  cooker?: boolean;
  bumpedById?: unknown;
}): Promise<KdsBumpOutcome> {
  const ticketId = Number(input.ticketId || 0);
  const station = String(input.station || 'KITCHEN').toUpperCase();
  if (!ticketId) return 'invalid';
  const twoStage = isTwoStageKitchen(station, COOKER_ENABLED);
  const now = new Date();
  const at = now.toISOString();
  let changed: any = null;
  const outcome: KdsBumpOutcome = await (prisma as any).$transaction(
    async (tx: any) => {
      const ticket = await tx.kdsTicket.findUnique({
        where: { id: ticketId },
        include: { order: true },
      });
      if (!ticket) return 'not-found';
      changed = ticket;
      const items: any[] = Array.isArray(ticket.itemsJson)
        ? ticket.itemsJson
        : [];
      // Cook (stage 1) flags the lines cooked; the card stays open for the
      // pass to pick up.
      if (twoStage && input.cooker) {
        await tx.kdsTicket.update({
          where: { id: ticketId },
          data: { itemsJson: cookerBumpAllKitchenItems(items, at) },
        });
        return 'ok';
      }
      // Pass (stage 2) finalises only the lines the cook finished.
      const next = twoStage
        ? bumpReadyKitchenItems(items, at)
        : bumpAllStationItemsInJson(items, station, at);
      await tx.kdsTicket.update({
        where: { id: ticketId },
        data: { itemsJson: next },
      });
      if (!liveOnStation(next, station)) {
        await completeStation(
          tx,
          ticketId,
          station,
          now,
          await safeUserId(tx, input.bumpedById),
        );
      }
      return 'ok';
    },
  );
  if (changed) notifyKdsTicketChanged(changed);
  return outcome;
}

/** Bump one line (`itemIdx` into the card's lines). */
export async function bumpKdsItem(input: {
  ticketId: unknown;
  station: unknown;
  itemIdx: unknown;
  cooker?: boolean;
  bumpedById?: unknown;
}): Promise<KdsBumpOutcome> {
  const ticketId = Number(input.ticketId || 0);
  const station = String(input.station || 'KITCHEN').toUpperCase();
  const idx = Number(input.itemIdx ?? -1);
  if (!ticketId || !Number.isInteger(idx) || idx < 0) return 'invalid';
  const twoStage = isTwoStageKitchen(station, COOKER_ENABLED);
  const now = new Date();
  const at = now.toISOString();
  let changed: any = null;
  const outcome: KdsBumpOutcome = await (prisma as any).$transaction(
    async (tx: any) => {
      const ticket = await tx.kdsTicket.findUnique({
        where: { id: ticketId },
        include: { order: true },
      });
      if (!ticket) return 'not-found';
      const items: any[] = Array.isArray(ticket.itemsJson)
        ? ticket.itemsJson
        : [];
      const it = items[idx];
      if (!it || !onStation(it, station)) return 'invalid';
      // Struck lines have nothing left to do.
      if (it.voided) return 'ok';
      if (twoStage && input.cooker) {
        if (it.cookerBumped) return 'ok';
        await tx.kdsTicket.update({
          where: { id: ticketId },
          data: { itemsJson: cookerBumpSingleKitchenItem(items, idx, at) },
        });
        changed = ticket;
        return 'ok';
      }
      // The pass cannot finish a line the cook has not.
      if (twoStage && !it.cookerBumped && !it.bumped) return 'locked';
      if (it.bumped) return 'ok';
      const next = items.slice();
      next[idx] = { ...it, bumped: true, bumpedAt: at };
      await tx.kdsTicket.update({
        where: { id: ticketId },
        data: { itemsJson: next },
      });
      if (!liveOnStation(next, station)) {
        await completeStation(
          tx,
          ticketId,
          station,
          now,
          await safeUserId(tx, input.bumpedById),
        );
      }
      changed = ticket;
      return 'ok';
    },
  );
  if (changed) notifyKdsTicketChanged(changed);
  return outcome;
}
