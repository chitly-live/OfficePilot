-- AlterTable
ALTER TABLE "User" ADD COLUMN     "moduleAccess" TEXT[] DEFAULT ARRAY[]::TEXT[];
