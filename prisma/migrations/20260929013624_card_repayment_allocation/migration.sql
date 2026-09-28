-- CreateTable
CREATE TABLE "CardRepaymentAllocation" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardRepaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CardRepaymentAllocation_accountId_idx" ON "CardRepaymentAllocation"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "CardRepaymentAllocation_transactionId_accountId_key" ON "CardRepaymentAllocation"("transactionId", "accountId");

-- AddForeignKey
ALTER TABLE "CardRepaymentAllocation" ADD CONSTRAINT "CardRepaymentAllocation_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "FinanceTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardRepaymentAllocation" ADD CONSTRAINT "CardRepaymentAllocation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "FinanceAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

