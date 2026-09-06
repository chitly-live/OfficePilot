-- AlterEnum
ALTER TYPE "FinancePartyType" ADD VALUE 'INTERMEDIARY';

-- AlterTable
ALTER TABLE "FinanceTransaction" ADD COLUMN     "viaPartyId" TEXT;

-- CreateIndex
CREATE INDEX "FinanceTransaction_viaPartyId_idx" ON "FinanceTransaction"("viaPartyId");

-- AddForeignKey
ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_viaPartyId_fkey" FOREIGN KEY ("viaPartyId") REFERENCES "FinanceParty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
