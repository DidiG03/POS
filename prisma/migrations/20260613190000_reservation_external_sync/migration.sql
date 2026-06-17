-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN "externalSource" TEXT;
ALTER TABLE "Reservation" ADD COLUMN "externalId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_externalSource_externalId_key" ON "Reservation"("externalSource", "externalId");
