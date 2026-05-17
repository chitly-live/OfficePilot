-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "activeSince" TEXT,
ADD COLUMN     "address" TEXT,
ADD COLUMN     "age" INTEGER,
ADD COLUMN     "extraDetails" TEXT,
ADD COLUMN     "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "notOnWhatsapp" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "phoneType" TEXT;
