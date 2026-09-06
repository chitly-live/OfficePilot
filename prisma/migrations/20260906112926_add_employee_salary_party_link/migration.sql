-- AlterEnum
ALTER TYPE "FinancePartyType" ADD VALUE 'EMPLOYEE';

-- AlterTable
ALTER TABLE "FinanceParty" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "monthlySalary" DOUBLE PRECISION,
ADD COLUMN     "salaryLabel" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "FinanceParty_userId_key" ON "FinanceParty"("userId");

-- AddForeignKey
ALTER TABLE "FinanceParty" ADD CONSTRAINT "FinanceParty_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

