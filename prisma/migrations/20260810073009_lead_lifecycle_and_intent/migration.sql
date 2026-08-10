-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('DISCOVERED_ACCOUNT', 'OPPORTUNITY_HYPOTHESIS', 'INTENT_DETECTED', 'QUALIFIED_LEAD', 'ACTIVE_OPPORTUNITY', 'DISQUALIFIED', 'NURTURE');

-- CreateEnum
CREATE TYPE "AssertionTier" AS ENUM ('SOURCE_FACT', 'SYSTEM_INFERENCE', 'USER_CONFIRMED');

-- CreateEnum
CREATE TYPE "IntentKind" AS ENUM ('PERMIT_FILED', 'FACILITY_OPENING', 'EXPANSION', 'JOB_POSTING', 'VENDOR_REGISTRATION', 'PURCHASING_NOTICE', 'CONTRACT_AWARD', 'CONTRACT_EXPIRY', 'INCUMBENT_CHANGE', 'RFQ_ISSUED', 'CONVERSATION_CONFIRMED');

-- CreateEnum
CREATE TYPE "ContactKind" AS ENUM ('ROUTING', 'DIRECT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED_BY_CALL', 'VERIFIED_BY_SOURCE', 'INVALID');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "cityName" TEXT,
ADD COLUMN     "normalizedAddress" TEXT,
ADD COLUMN     "normalizedPhone" TEXT,
ADD COLUMN     "stateCode" TEXT;

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "contactKind" "ContactKind" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "isDecisionMaker" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "purchasingAuthority" TEXT,
ADD COLUMN     "roleTier" "AssertionTier" NOT NULL DEFAULT 'SYSTEM_INFERENCE',
ADD COLUMN     "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DiscoverySignal" ADD COLUMN     "cityName" TEXT,
ADD COLUMN     "firstDiscoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "hypothesisId" TEXT,
ADD COLUMN     "sourcePublishedAt" TIMESTAMP(3),
ADD COLUMN     "stateCode" TEXT,
ADD COLUMN     "tier" "AssertionTier" NOT NULL DEFAULT 'SOURCE_FACT';

-- CreateTable
CREATE TABLE "PathHypothesis" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "pathId" TEXT NOT NULL,
    "stage" "LeadStage" NOT NULL DEFAULT 'DISCOVERED_ACCOUNT',
    "accountFitScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "intentScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "contactabilityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fulfillmentReadinessScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priorityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "scoreExplanation" JSONB NOT NULL DEFAULT '{}',
    "needEvidence" JSONB,
    "decisionMakerId" TEXT,
    "timingEvidence" JSONB,
    "fitEvidence" JSONB,
    "nextStep" TEXT,
    "firstDiscoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastIntentSignalAt" TIMESTAMP(3),
    "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disqualifiedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PathHypothesis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntentEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "hypothesisId" TEXT,
    "kind" "IntentKind" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "headline" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "tier" "AssertionTier" NOT NULL DEFAULT 'SOURCE_FACT',
    "dedupeHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PathHypothesis_orgId_stage_priorityScore_idx" ON "PathHypothesis"("orgId", "stage", "priorityScore");

-- CreateIndex
CREATE UNIQUE INDEX "PathHypothesis_companyId_pathId_key" ON "PathHypothesis"("companyId", "pathId");

-- CreateIndex
CREATE INDEX "IntentEvent_orgId_companyId_occurredAt_idx" ON "IntentEvent"("orgId", "companyId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "IntentEvent_orgId_dedupeHash_key" ON "IntentEvent"("orgId", "dedupeHash");

-- AddForeignKey
ALTER TABLE "PathHypothesis" ADD CONSTRAINT "PathHypothesis_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PathHypothesis" ADD CONSTRAINT "PathHypothesis_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PathHypothesis" ADD CONSTRAINT "PathHypothesis_pathId_fkey" FOREIGN KEY ("pathId") REFERENCES "BusinessPath"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PathHypothesis" ADD CONSTRAINT "PathHypothesis_decisionMakerId_fkey" FOREIGN KEY ("decisionMakerId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntentEvent" ADD CONSTRAINT "IntentEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntentEvent" ADD CONSTRAINT "IntentEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntentEvent" ADD CONSTRAINT "IntentEvent_hypothesisId_fkey" FOREIGN KEY ("hypothesisId") REFERENCES "PathHypothesis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoverySignal" ADD CONSTRAINT "DiscoverySignal_hypothesisId_fkey" FOREIGN KEY ("hypothesisId") REFERENCES "PathHypothesis"("id") ON DELETE SET NULL ON UPDATE CASCADE;
