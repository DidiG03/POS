-- CreateTable
CREATE TABLE "Area" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "defaultCount" INTEGER NOT NULL DEFAULT 8
);

-- CreateIndex
CREATE UNIQUE INDEX "Area_name_key" ON "Area"("name");
