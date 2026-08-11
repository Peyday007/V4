-- The demand engine.
--
-- Until now the acquisition pattern was: find a company, match its category,
-- infer a generic need, score it. None of those inputs is an event, so the
-- pattern could not produce demand — a gym existing is not a cleaning
-- opportunity, whereas a gym opening in three weeks is.
--
-- This makes the event a first-class object, separate from the company it
-- involves and separate from the commercial routes built on it. The three are
-- different things and were previously one.

CREATE TYPE "DemandEventType" AS ENUM (
  'ACTIVE_RFP', 'ACTIVE_RFQ', 'PROCUREMENT_NOTICE', 'VENDOR_REQUEST',
  'SUBCONTRACTOR_REQUEST', 'CONTRACT_AWARD', 'FACILITY_OPENING',
  'OCCUPANCY_OR_OPERATING_APPROVAL', 'RENOVATION_OR_CONSTRUCTION', 'EXPANSION',
  'PROPERTY_TURNOVER', 'NEW_LOCATION', 'NEW_LEASE', 'CONTRACT_EXPIRATION',
  'VENDOR_FAILURE_OR_COMPLAINT', 'STAFFING_OR_CAPACITY_GAP', 'INBOUND_REQUEST'
);

CREATE TYPE "EventLifecycle" AS ENUM (
  'DISCOVERED', 'VERIFIED', 'QUARANTINED', 'EXPIRED', 'REJECTED', 'SUPERSEDED'
);

CREATE TYPE "DemandVerification" AS ENUM (
  'UNVERIFIED', 'AUTO_VERIFIED', 'HUMAN_VERIFIED', 'FAILED'
);

-- Deliberately separate from LeadTier. A federal solicitation is unambiguous
-- demand and a miserable relationship; an independent gym opening is a weaker
-- signal and a single phone call.
CREATE TYPE "FrictionLevel" AS ENUM (
  'LOW', 'MODERATE', 'HIGH', 'UNKNOWN_RESEARCH_REQUIRED'
);

CREATE TYPE "EventPartyRole" AS ENUM (
  'BUYER', 'PROPERTY_OWNER', 'PROPERTY_MANAGER', 'PRIME_CONTRACTOR',
  'INCUMBENT_PROVIDER', 'APPLICANT', 'ISSUING_AUTHORITY', 'MENTIONED'
);

CREATE TABLE "DemandEvent" (
  "id"                  TEXT NOT NULL,
  "orgId"               TEXT NOT NULL,
  "type"                "DemandEventType" NOT NULL,
  "lifecycle"           "EventLifecycle" NOT NULL DEFAULT 'DISCOVERED',
  "verification"        "DemandVerification" NOT NULL DEFAULT 'UNVERIFIED',
  "connector"           TEXT NOT NULL,
  "sourceRecordId"      TEXT NOT NULL,
  "sourceUrl"           TEXT,
  "rawPayload"          JSONB NOT NULL DEFAULT '{}',
  -- The date the SOURCE states. Nullable, because many records genuinely carry
  -- none, and inventing one from ingestion time is the defect this replaces.
  "eventDate"           TIMESTAMP(3),
  "discoveredAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deadlineAt"          TIMESTAMP(3),
  "opensAt"             TIMESTAMP(3),
  "completesAt"         TIMESTAMP(3),
  "effectiveAt"         TIMESTAMP(3),
  "headline"            TEXT NOT NULL,
  "summary"             TEXT NOT NULL,
  "cityName"            TEXT,
  "stateCode"           TEXT,
  "postalCode"          TEXT,
  "addressLine1"        TEXT,
  "confirmedFacts"      JSONB NOT NULL DEFAULT '[]',
  "inferredFacts"       JSONB NOT NULL DEFAULT '[]',
  "mentionedNames"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "confidence"          DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  "sourceReliability"   DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  "relatedCapabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "dedupeKey"           TEXT NOT NULL,
  "expiredReason"       TEXT,
  "rejectedReason"      TEXT,
  "quarantineReason"    TEXT,
  "lastVerifiedAt"      TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DemandEvent_pkey" PRIMARY KEY ("id")
);

-- Several sources describing the same event converge on one row rather than
-- creating duplicates; the dedupe key is the identity.
CREATE UNIQUE INDEX "DemandEvent_orgId_dedupeKey_key" ON "DemandEvent"("orgId", "dedupeKey");
CREATE INDEX "DemandEvent_orgId_lifecycle_eventDate_idx" ON "DemandEvent"("orgId", "lifecycle", "eventDate");
CREATE INDEX "DemandEvent_orgId_type_eventDate_idx" ON "DemandEvent"("orgId", "type", "eventDate");
CREATE INDEX "DemandEvent_orgId_connector_discoveredAt_idx" ON "DemandEvent"("orgId", "connector", "discoveredAt");

CREATE TABLE "DemandEventParty" (
  "id"                   TEXT NOT NULL,
  "eventId"              TEXT NOT NULL,
  "companyId"            TEXT,
  "role"                 "EventPartyRole" NOT NULL,
  -- Kept even after resolution, so a wrong match can always be traced back to
  -- the words the source actually used.
  "sourceName"           TEXT NOT NULL,
  "resolutionConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "resolutionMethod"     TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DemandEventParty_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DemandEventParty_eventId_role_sourceName_key"
  ON "DemandEventParty"("eventId", "role", "sourceName");
CREATE INDEX "DemandEventParty_companyId_idx" ON "DemandEventParty"("companyId");

CREATE TABLE "RouteHypothesis" (
  "id"                    TEXT NOT NULL,
  "orgId"                 TEXT NOT NULL,
  "eventId"               TEXT NOT NULL,
  "companyId"             TEXT NOT NULL,
  "pathId"                TEXT,
  "route"                 "SignalCategory" NOT NULL,
  "playbookKey"           TEXT NOT NULL,
  "headline"              TEXT NOT NULL,
  "rationale"             TEXT NOT NULL,
  "tier"                  "LeadTier" NOT NULL DEFAULT 'DIRECTORY_PROSPECT',
  "friction"              "FrictionLevel" NOT NULL DEFAULT 'UNKNOWN_RESEARCH_REQUIRED',
  "frictionReason"        TEXT,
  "frictionFactors"       JSONB NOT NULL DEFAULT '[]',
  "needIsConfirmed"       BOOLEAN NOT NULL DEFAULT false,
  "requiredCapability"    TEXT,
  "buyerRole"             "EventPartyRole" NOT NULL DEFAULT 'BUYER',
  "buyingWindow"          TEXT,
  "windowOpensAt"         TIMESTAMP(3),
  "windowClosesAt"        TIMESTAMP(3),
  "fulfilmentStatus"      TEXT NOT NULL DEFAULT 'UNKNOWN',
  "providerCount"         DOUBLE PRECISION NOT NULL DEFAULT 0,
  "estimatedBuyerPrice"   DECIMAL(14,2),
  "estimatedProviderCost" DECIMAL(14,2),
  "estimatedGrossProfit"  DECIMAL(14,2),
  "estimatedHumanMinutes" INTEGER,
  "economicsBasis"        TEXT,
  "commercialStructure"   TEXT,
  "structureReason"       TEXT,
  "status"                TEXT NOT NULL DEFAULT 'RESEARCH',
  "statusReason"          TEXT,
  "missingInfo"           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "nextAction"            TEXT,
  "nextActionBy"          TIMESTAMP(3),
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RouteHypothesis_pkey" PRIMARY KEY ("id")
);

-- One route per (event, account, playbook). This is what makes re-running the
-- pipeline idempotent rather than duplicating the board on every pass.
CREATE UNIQUE INDEX "RouteHypothesis_eventId_companyId_playbookKey_key"
  ON "RouteHypothesis"("eventId", "companyId", "playbookKey");
CREATE INDEX "RouteHypothesis_orgId_tier_friction_idx" ON "RouteHypothesis"("orgId", "tier", "friction");
CREATE INDEX "RouteHypothesis_orgId_route_status_idx" ON "RouteHypothesis"("orgId", "route", "status");

-- A source that silently returns nothing looks identical to a quiet week, and
-- the difference is the whole question when discovery produces no demand.
CREATE TABLE "SourceRun" (
  "id"              TEXT NOT NULL,
  "orgId"           TEXT NOT NULL,
  "dataSourceId"    TEXT,
  "connector"       TEXT NOT NULL,
  "startedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"      TIMESTAMP(3),
  "status"          TEXT NOT NULL DEFAULT 'RUNNING',
  "recordsExamined" INTEGER NOT NULL DEFAULT 0,
  "eventsCreated"   INTEGER NOT NULL DEFAULT 0,
  "eventsUpdated"   INTEGER NOT NULL DEFAULT 0,
  "eventsRejected"  INTEGER NOT NULL DEFAULT 0,
  "cursor"          TEXT,
  "windowStart"     TIMESTAMP(3),
  "windowEnd"       TIMESTAMP(3),
  "error"           TEXT,
  "details"         JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "SourceRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SourceRun_orgId_connector_startedAt_idx" ON "SourceRun"("orgId", "connector", "startedAt");

-- Evidence can now point at an event as well as a company.
ALTER TABLE "SourceEvidence" ADD COLUMN "demandEventId" TEXT;

ALTER TABLE "DemandEvent" ADD CONSTRAINT "DemandEvent_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DemandEventParty" ADD CONSTRAINT "DemandEventParty_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "DemandEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DemandEventParty" ADD CONSTRAINT "DemandEventParty_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RouteHypothesis" ADD CONSTRAINT "RouteHypothesis_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RouteHypothesis" ADD CONSTRAINT "RouteHypothesis_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "DemandEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RouteHypothesis" ADD CONSTRAINT "RouteHypothesis_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RouteHypothesis" ADD CONSTRAINT "RouteHypothesis_pathId_fkey"
  FOREIGN KEY ("pathId") REFERENCES "BusinessPath"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SourceRun" ADD CONSTRAINT "SourceRun_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SourceRun" ADD CONSTRAINT "SourceRun_dataSourceId_fkey"
  FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SourceEvidence" ADD CONSTRAINT "SourceEvidence_demandEventId_fkey"
  FOREIGN KEY ("demandEventId") REFERENCES "DemandEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
