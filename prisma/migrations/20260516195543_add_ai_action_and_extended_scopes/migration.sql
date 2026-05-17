-- CreateTable
CREATE TABLE "AIAction" (
    "id" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priority" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "sourceInsightId" TEXT,
    "metadata" JSONB,

    CONSTRAINT "AIAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AIAction_priority_status_idx" ON "AIAction"("priority", "status");

-- CreateIndex
CREATE INDEX "AIAction_status_generatedAt_idx" ON "AIAction"("status", "generatedAt");
