-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('PHYSICAL', 'DIGITAL');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('IN_USE', 'IN_STOCK', 'REPAIR', 'LOST', 'SOLD', 'SCRAPPED');

-- AlterEnum
ALTER TYPE "FinanceCategory" ADD VALUE 'ASSET_PURCHASE';

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL DEFAULT 'PHYSICAL',
    "category" TEXT,
    "identifier" TEXT,
    "purchaseDate" TIMESTAMP(3),
    "cost" DOUBLE PRECISION,
    "transactionId" TEXT,
    "status" "AssetStatus" NOT NULL DEFAULT 'IN_STOCK',
    "renewsOn" TIMESTAMP(3),
    "notes" TEXT,
    "productId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetAssignment" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "toUserId" TEXT,
    "toPartyId" TEXT,
    "location" TEXT,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthClose" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedById" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "MonthClose_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthCloseBalance" (
    "id" TEXT NOT NULL,
    "monthCloseId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "balance" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "MonthCloseBalance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Asset_transactionId_key" ON "Asset"("transactionId");

-- CreateIndex
CREATE INDEX "Asset_status_idx" ON "Asset"("status");

-- CreateIndex
CREATE INDEX "Asset_kind_idx" ON "Asset"("kind");

-- CreateIndex
CREATE INDEX "Asset_productId_idx" ON "Asset"("productId");

-- CreateIndex
CREATE INDEX "Asset_renewsOn_idx" ON "Asset"("renewsOn");

-- CreateIndex
CREATE INDEX "Asset_name_idx" ON "Asset"("name");

-- CreateIndex
CREATE INDEX "AssetAssignment_assetId_toDate_idx" ON "AssetAssignment"("assetId", "toDate");

-- CreateIndex
CREATE INDEX "AssetAssignment_toUserId_idx" ON "AssetAssignment"("toUserId");

-- CreateIndex
CREATE INDEX "AssetAssignment_toPartyId_idx" ON "AssetAssignment"("toPartyId");

-- CreateIndex
CREATE UNIQUE INDEX "MonthClose_month_key" ON "MonthClose"("month");

-- CreateIndex
CREATE INDEX "MonthCloseBalance_accountId_idx" ON "MonthCloseBalance"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "MonthCloseBalance_monthCloseId_accountId_key" ON "MonthCloseBalance"("monthCloseId", "accountId");

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "FinanceTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignment" ADD CONSTRAINT "AssetAssignment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignment" ADD CONSTRAINT "AssetAssignment_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignment" ADD CONSTRAINT "AssetAssignment_toPartyId_fkey" FOREIGN KEY ("toPartyId") REFERENCES "FinanceParty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignment" ADD CONSTRAINT "AssetAssignment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthClose" ADD CONSTRAINT "MonthClose_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthCloseBalance" ADD CONSTRAINT "MonthCloseBalance_monthCloseId_fkey" FOREIGN KEY ("monthCloseId") REFERENCES "MonthClose"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthCloseBalance" ADD CONSTRAINT "MonthCloseBalance_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "FinanceAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

