-- CreateTable
CREATE TABLE "GstReturn" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "itcUsed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cashPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paidOn" TIMESTAMP(3),
    "cashAccountId" TEXT,
    "reference" TEXT,
    "notes" TEXT,
    "cashTransactionId" TEXT,
    "itcTransactionId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GstReturn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GstReturn_month_key" ON "GstReturn"("month");

-- CreateIndex
CREATE UNIQUE INDEX "GstReturn_cashTransactionId_key" ON "GstReturn"("cashTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "GstReturn_itcTransactionId_key" ON "GstReturn"("itcTransactionId");

-- CreateIndex
CREATE INDEX "GstReturn_month_idx" ON "GstReturn"("month");

-- AddForeignKey
ALTER TABLE "GstReturn" ADD CONSTRAINT "GstReturn_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "FinanceAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GstReturn" ADD CONSTRAINT "GstReturn_cashTransactionId_fkey" FOREIGN KEY ("cashTransactionId") REFERENCES "FinanceTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GstReturn" ADD CONSTRAINT "GstReturn_itcTransactionId_fkey" FOREIGN KEY ("itcTransactionId") REFERENCES "FinanceTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GstReturn" ADD CONSTRAINT "GstReturn_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

