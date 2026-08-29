-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN "seatedAt" DATETIME;

-- Currently seated parties keep occupying from the booked slot.
UPDATE "Reservation" SET "seatedAt" = "startsAt" WHERE "status" = 'SEATED' AND "seatedAt" IS NULL;
