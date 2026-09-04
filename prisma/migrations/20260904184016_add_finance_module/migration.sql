-- CreateEnum
CREATE TYPE "FinanceDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "FinancePartyType" AS ENUM ('FINANCER', 'CARD_OWNER', 'WORKER', 'VENDOR', 'CLIENT', 'OTHER');

-- CreateEnum
CREATE TYPE "FinanceAccountType" AS ENUM ('BANK', 'CASH', 'UPI', 'CREDIT_CARD', 'WALLET', 'OTHER');

-- CreateEnum
CREATE TYPE "FinanceCategory" AS ENUM ('SALES', 'SERVICE_INCOME', 'LOAN_RECEIVED', 'INVESTMENT_RECEIVED', 'REFUND_RECEIVED', 'OTHER_INCOME', 'ADS', 'SOFTWARE', 'PAYOUT', 'SALARY', 'PROFESSIONAL_FEES', 'LOAN_REPAYMENT', 'CARD_REPAYMENT', 'RENT', 'UTILITIES', 'OFFICE', 'TRAVEL', 'TAX', 'BANK_CHARGES', 'OTHER_EXPENSE');

-- CreateTable
CREATE TABLE "FinanceParty" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FinancePartyType" NOT NULL DEFAULT 'OTHER',
    "phone" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceParty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FinanceAccountType" NOT NULL DEFAULT 'BANK',
    "ownerPartyId" TEXT,
    "openingBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceTransaction" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "direction" "FinanceDirection" NOT NULL,
    "category" "FinanceCategory" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "originalAmount" DOUBLE PRECISION,
    "originalCurrency" TEXT,
    "description" TEXT,
    "reference" TEXT,
    "dueDate" TIMESTAMP(3),
    "partyId" TEXT,
    "accountId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FinanceParty_type_idx" ON "FinanceParty"("type");

-- CreateIndex
CREATE INDEX "FinanceParty_name_idx" ON "FinanceParty"("name");

-- CreateIndex
CREATE INDEX "FinanceAccount_type_idx" ON "FinanceAccount"("type");

-- CreateIndex
CREATE INDEX "FinanceAccount_ownerPartyId_idx" ON "FinanceAccount"("ownerPartyId");

-- CreateIndex
CREATE INDEX "FinanceTransaction_date_idx" ON "FinanceTransaction"("date");

-- CreateIndex
CREATE INDEX "FinanceTransaction_direction_idx" ON "FinanceTransaction"("direction");

-- CreateIndex
CREATE INDEX "FinanceTransaction_category_idx" ON "FinanceTransaction"("category");

-- CreateIndex
CREATE INDEX "FinanceTransaction_partyId_idx" ON "FinanceTransaction"("partyId");

-- CreateIndex
CREATE INDEX "FinanceTransaction_accountId_idx" ON "FinanceTransaction"("accountId");

-- AddForeignKey
ALTER TABLE "FinanceParty" ADD CONSTRAINT "FinanceParty_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceAccount" ADD CONSTRAINT "FinanceAccount_ownerPartyId_fkey" FOREIGN KEY ("ownerPartyId") REFERENCES "FinanceParty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "FinanceParty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "FinanceAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
