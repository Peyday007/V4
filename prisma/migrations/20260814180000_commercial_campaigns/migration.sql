-- CreateEnum
CREATE TYPE "EvidenceClass" AS ENUM ('CONFIRMED_BY_PERSON', 'EXTERNALLY_OBSERVED', 'CALCULATED_FROM_CONFIRMED_INPUTS', 'INFERRED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CampaignState" AS ENUM ('DRAFT', 'AWAITING_AUTHORITY', 'RUNNING', 'PAUSED', 'KILLED', 'EXPANDED', 'CONCLUDED');

-- CreateEnum
CREATE TYPE "CampaignEvidenceKind" AS ENUM ('SUPPORTING', 'CONTRARY');

-- CreateEnum
CREATE TYPE "CampaignChannelKind" AS ENUM ('CALLING', 'EMAIL', 'ADVERTISING', 'DIRECT_MAIL', 'PARTNER_REFERRAL', 'VENDOR_REGISTRATION');

-- CreateEnum
CREATE TYPE "CampaignConditionKind" AS ENUM ('KILL', 'EXPAND');

-- CreateEnum
CREATE TYPE "CampaignMetric" AS ENUM ('ROUTES_GENERATED', 'CONVERSATIONS_HELD', 'REQUIREMENTS_CONFIRMED', 'PROVIDERS_VERIFIED', 'QUOTES_SENT', 'COMMITMENTS_WON', 'COLLECTED_GROSS_PROFIT', 'SPEND', 'DAYS_RUNNING', 'RETURN_ON_SPEND');

-- CreateEnum
CREATE TYPE "CampaignComparator" AS ENUM ('BELOW', 'AT_OR_BELOW', 'ABOVE', 'AT_OR_ABOVE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SignalCategory" ADD VALUE 'DIRECT_SERVICE';
ALTER TYPE "SignalCategory" ADD VALUE 'SUPPLIER_DEVELOPMENT';
ALTER TYPE "SignalCategory" ADD VALUE 'PROVIDER_RECRUITMENT';

-- AlterTable
ALTER TABLE "RouteHypothesis" ADD COLUMN     "campaignId" TEXT;

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dataMode" "DataMode" NOT NULL DEFAULT 'PRODUCTION',
    "name" TEXT NOT NULL,
    "state" "CampaignState" NOT NULL DEFAULT 'DRAFT',
    "thesis" TEXT NOT NULL,
    "whyNow" TEXT NOT NULL,
    "route" "SignalCategory" NOT NULL,
    "commercialStructure" TEXT,
    "targetStates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetCities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "buyerProfile" TEXT NOT NULL,
    "providerProfile" TEXT NOT NULL,
    "requiredCapability" TEXT NOT NULL,
    "testingHours" DOUBLE PRECISION NOT NULL,
    "testingCostCents" INTEGER NOT NULL DEFAULT 0,
    "testingCostBasis" TEXT NOT NULL,
    "budgetCents" INTEGER,
    "authorityGrantedById" TEXT,
    "authorityGrantedAt" TIMESTAMP(3),
    "authorityScope" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedReason" TEXT,
    "learning" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignEvidence" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" "CampaignEvidenceKind" NOT NULL,
    "claim" TEXT NOT NULL,
    "evidenceClass" "EvidenceClass" NOT NULL DEFAULT 'INFERRED',
    "sourceUrl" TEXT,
    "observedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignChannel" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" "CampaignChannelKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "budgetCents" INTEGER,
    "spentCents" INTEGER NOT NULL DEFAULT 0,
    "authorisedById" TEXT,
    "authorisedAt" TIMESTAMP(3),
    "authorityNote" TEXT,
    "outcomeMetric" "CampaignMetric",

    CONSTRAINT "CampaignChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignCondition" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" "CampaignConditionKind" NOT NULL,
    "metric" "CampaignMetric" NOT NULL,
    "comparator" "CampaignComparator" NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "afterDays" INTEGER NOT NULL DEFAULT 0,
    "statement" TEXT NOT NULL,
    "met" BOOLEAN NOT NULL DEFAULT false,
    "metAt" TIMESTAMP(3),
    "lastValue" DOUBLE PRECISION,
    "evaluatedAt" TIMESTAMP(3),

    CONSTRAINT "CampaignCondition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignTask" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "dataMode" "DataMode" NOT NULL DEFAULT 'PRODUCTION',
    "kind" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "companyId" TEXT,
    "routeId" TEXT,
    "result" TEXT,
    "evidenceClass" "EvidenceClass" NOT NULL DEFAULT 'UNKNOWN',
    "sourceUrl" TEXT,
    "because" TEXT,
    "attemptedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_orgId_state_idx" ON "Campaign"("orgId", "state");

-- CreateIndex
CREATE INDEX "Campaign_orgId_dataMode_state_idx" ON "Campaign"("orgId", "dataMode", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_orgId_name_key" ON "Campaign"("orgId", "name");

-- CreateIndex
CREATE INDEX "CampaignEvidence_orgId_campaignId_kind_idx" ON "CampaignEvidence"("orgId", "campaignId", "kind");

-- CreateIndex
CREATE INDEX "CampaignChannel_orgId_campaignId_idx" ON "CampaignChannel"("orgId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignChannel_campaignId_kind_key" ON "CampaignChannel"("campaignId", "kind");

-- CreateIndex
CREATE INDEX "CampaignCondition_orgId_campaignId_kind_idx" ON "CampaignCondition"("orgId", "campaignId", "kind");

-- CreateIndex
CREATE INDEX "CampaignTask_orgId_campaignId_status_idx" ON "CampaignTask"("orgId", "campaignId", "status");

-- CreateIndex
CREATE INDEX "CampaignTask_orgId_dataMode_status_idx" ON "CampaignTask"("orgId", "dataMode", "status");

-- AddForeignKey
ALTER TABLE "RouteHypothesis" ADD CONSTRAINT "RouteHypothesis_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_authorityGrantedById_fkey" FOREIGN KEY ("authorityGrantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignEvidence" ADD CONSTRAINT "CampaignEvidence_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignEvidence" ADD CONSTRAINT "CampaignEvidence_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignChannel" ADD CONSTRAINT "CampaignChannel_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignChannel" ADD CONSTRAINT "CampaignChannel_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignCondition" ADD CONSTRAINT "CampaignCondition_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignCondition" ADD CONSTRAINT "CampaignCondition_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTask" ADD CONSTRAINT "CampaignTask_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTask" ADD CONSTRAINT "CampaignTask_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTask" ADD CONSTRAINT "CampaignTask_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTask" ADD CONSTRAINT "CampaignTask_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "RouteHypothesis"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Campaign work cannot cross the practice boundary
-- ---------------------------------------------------------------------------
--
-- Same pattern as every other guard here, and the same reason for the shape:
-- a guard that *compares* modes forces every writer to remember to set one,
-- and one that *sets* the mode from the parent on insert cannot be forgotten.
-- A campaign task inherits its campaign's mode; an update that tries to move
-- it is refused outright.
CREATE OR REPLACE FUNCTION "campaignTaskDataModeGuard"() RETURNS TRIGGER AS $$
DECLARE
  parent_mode "DataMode";
BEGIN
  SELECT c."dataMode" INTO parent_mode FROM "Campaign" c WHERE c."id" = NEW."campaignId";
  IF parent_mode IS NULL THEN
    RAISE EXCEPTION 'CampaignTask % references a campaign that does not exist', NEW."id";
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW."dataMode" := parent_mode;
  ELSIF NEW."dataMode" <> parent_mode THEN
    RAISE EXCEPTION
      'CampaignTask % is % but its campaign is %. Practice work and production work do not mix.',
      NEW."id", NEW."dataMode", parent_mode;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "campaignTaskDataModeGuard" ON "CampaignTask";
CREATE TRIGGER "campaignTaskDataModeGuard"
  BEFORE INSERT OR UPDATE ON "CampaignTask"
  FOR EACH ROW EXECUTE FUNCTION "campaignTaskDataModeGuard"();

-- A route may only belong to a campaign in the same world. Without this a
-- practice campaign could claim a production route and its outcomes would be
-- counted as real.
CREATE OR REPLACE FUNCTION "routeCampaignDataModeGuard"() RETURNS TRIGGER AS $$
DECLARE
  campaign_mode "DataMode";
BEGIN
  IF NEW."campaignId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT c."dataMode" INTO campaign_mode FROM "Campaign" c WHERE c."id" = NEW."campaignId";
  IF campaign_mode IS NOT NULL AND campaign_mode <> NEW."dataMode" THEN
    RAISE EXCEPTION
      'Route % is % but campaign % is %. A practice campaign cannot claim production work.',
      NEW."id", NEW."dataMode", NEW."campaignId", campaign_mode;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "routeCampaignDataModeGuard" ON "RouteHypothesis";
CREATE TRIGGER "routeCampaignDataModeGuard"
  BEFORE INSERT OR UPDATE ON "RouteHypothesis"
  FOR EACH ROW EXECUTE FUNCTION "routeCampaignDataModeGuard"();
