-- AlterTable
ALTER TABLE "FinanceAccount" ADD COLUMN     "billingDay" INTEGER,
ADD COLUMN     "creditLimit" DOUBLE PRECISION,
ADD COLUMN     "dueDay" INTEGER;

-- AlterTable
ALTER TABLE "FinanceTransaction" ADD COLUMN     "settlesAccountId" TEXT;

-- CreateIndex
CREATE INDEX "FinanceTransaction_settlesAccountId_idx" ON "FinanceTransaction"("settlesAccountId");

-- AddForeignKey
ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_settlesAccountId_fkey" FOREIGN KEY ("settlesAccountId") REFERENCES "FinanceAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

