-- CreateTable
CREATE TABLE "MigrationRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fileName" TEXT,
    "summary" TEXT NOT NULL,
    "report" TEXT NOT NULL
);
