-- AlterTable
ALTER TABLE "DiscoverySignal" ADD COLUMN     "classificationEvidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "duplicateOfId" TEXT,
ADD COLUMN     "pathId" TEXT;

-- CreateTable
CREATE TABLE "BusinessPath" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "legacyCategory" "SignalCategory",
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "leadRoles" "LeadRole"[] DEFAULT ARRAY[]::"LeadRole"[],
    "segments" "MarketSegment"[] DEFAULT ARRAY[]::"MarketSegment"[],
    "sourceKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "qualificationRules" JSONB NOT NULL DEFAULT '{}',
    "scoringWeights" JSONB NOT NULL DEFAULT '{}',
    "requiredFields" JSONB NOT NULL DEFAULT '[]',
    "matchingRules" JSONB NOT NULL DEFAULT '{}',
    "recommendedActions" JSONB NOT NULL DEFAULT '{}',
    "workflowStages" JSONB NOT NULL DEFAULT '[]',
    "complianceRules" JSONB NOT NULL DEFAULT '{}',
    "revenueModel" TEXT,
    "expectedCycleDays" INTEGER,
    "typicalMarginPct" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessPath_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessPath_orgId_isActive_priority_idx" ON "BusinessPath"("orgId", "isActive", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessPath_orgId_key_key" ON "BusinessPath"("orgId", "key");

-- AddForeignKey
ALTER TABLE "BusinessPath" ADD CONSTRAINT "BusinessPath_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoverySignal" ADD CONSTRAINT "DiscoverySignal_pathId_fkey" FOREIGN KEY ("pathId") REFERENCES "BusinessPath"("id") ON DELETE SET NULL ON UPDATE CASCADE;
