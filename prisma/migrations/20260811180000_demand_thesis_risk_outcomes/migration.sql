-- Lead thesis, risk, and the source-to-profit chain.
--
-- Three additions the demand engine needs before a route can be handed to a
-- person: an explanation of why this company and why now, an honest account of
-- the money at risk, and the beginning of the only measurement that decides
-- whether a source is worth running.

-- UNKNOWN is the default and a real value. A missing payment history is not a
-- good payment history, and defaulting it to LOW would put unverified
-- counterparties at the top of the queue.
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MODERATE', 'HIGH', 'UNKNOWN');

CREATE TYPE "OutcomeStage" AS ENUM (
  'SOURCE_RECORD', 'DEMAND_EVENT', 'VERIFIED_LEAD', 'CONTACTED', 'RESPONDED',
  'QUALIFIED_CONVERSATION', 'QUOTED', 'WON', 'LOST', 'COMPLETED', 'PAID'
);

ALTER TABLE "RouteHypothesis"
  ADD COLUMN "thesis"             JSONB,
  ADD COLUMN "maxCashExposure"    DECIMAL(14,2),
  ADD COLUMN "daysCapitalExposed" INTEGER,
  ADD COLUMN "paymentRisk"        "RiskLevel" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "counterpartyRisk"   "RiskLevel" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "complianceStatus"   TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "complianceGaps"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "riskNotes"          JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "fulfilmentReason"   TEXT,
  ADD COLUMN "matchedProviderIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- The chain is recorded from the beginning even though its later stages will
-- be empty for months. A source's worth is decided by completed paid jobs and
-- nothing else; counting records discovered is how a source that produces
-- fifty thousand companies and no revenue looks productive.
CREATE TABLE "DemandOutcome" (
  "id"                   TEXT NOT NULL,
  "orgId"                TEXT NOT NULL,
  "connector"            TEXT NOT NULL,
  "playbookKey"          TEXT,
  "route"                "SignalCategory",
  "eventId"              TEXT,
  "routeId"              TEXT,
  "stage"                "OutcomeStage" NOT NULL,
  "occurredAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Set only when money actually moved. Never an expectation.
  "collectedRevenue"     DECIMAL(14,2),
  "collectedGrossProfit" DECIMAL(14,2),
  "humanMinutes"         INTEGER,
  "note"                 TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DemandOutcome_pkey" PRIMARY KEY ("id")
);

-- One row per (route, stage), so a lead contacted twice has one contacted
-- milestone and the counts stay milestones rather than activity.
CREATE UNIQUE INDEX "DemandOutcome_routeId_stage_key" ON "DemandOutcome"("routeId", "stage");
CREATE INDEX "DemandOutcome_orgId_connector_stage_idx" ON "DemandOutcome"("orgId", "connector", "stage");
CREATE INDEX "DemandOutcome_orgId_occurredAt_idx" ON "DemandOutcome"("orgId", "occurredAt");

ALTER TABLE "DemandOutcome" ADD CONSTRAINT "DemandOutcome_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
