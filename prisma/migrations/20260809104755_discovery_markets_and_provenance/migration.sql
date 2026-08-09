-- CreateEnum
CREATE TYPE "DataOrigin" AS ENUM ('LIVE_DISCOVERY', 'IMPORTED', 'MANUAL', 'SEED_DEMO');

-- CreateEnum
CREATE TYPE "LeadRole" AS ENUM ('BUYER', 'PROVIDER', 'SUPPLIER', 'PARTNER', 'CONTRACTOR', 'SUBCONTRACTOR', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MarketSegment" AS ENUM ('COMMERCIAL', 'RESIDENTIAL', 'PUBLIC_SECTOR', 'INDUSTRIAL', 'MIXED');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "externalPlaceId" TEXT,
ADD COLUMN     "lastEnrichedAt" TIMESTAMP(3),
ADD COLUMN     "origin" "DataOrigin" NOT NULL DEFAULT 'SEED_DEMO';

-- AlterTable
ALTER TABLE "DataSource" ADD COLUMN     "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "credentialEnvVar" TEXT,
ADD COLUMN     "isLive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastErrorAt" TIMESTAMP(3),
ADD COLUMN     "lastRecordCount" INTEGER,
ADD COLUMN     "marketId" TEXT,
ADD COLUMN     "termsUrl" TEXT;

-- AlterTable
ALTER TABLE "DiscoverySignal" ADD COLUMN     "contactHint" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "leadRole" "LeadRole" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "marketId" TEXT,
ADD COLUMN     "origin" "DataOrigin" NOT NULL DEFAULT 'SEED_DEMO',
ADD COLUMN     "recommendedAction" TEXT,
ADD COLUMN     "requiredService" TEXT,
ADD COLUMN     "segment" "MarketSegment" NOT NULL DEFAULT 'MIXED',
ADD COLUMN     "sourceUrl" TEXT,
ADD COLUMN     "whyRelevant" TEXT;

-- AlterTable
ALTER TABLE "SourceEvidence" ADD COLUMN     "origin" "DataOrigin" NOT NULL DEFAULT 'SEED_DEMO';

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'metro',
    "country" TEXT NOT NULL DEFAULT 'US',
    "state" TEXT,
    "centerLat" DOUBLE PRECISION,
    "centerLng" DOUBLE PRECISION,
    "radiusMeters" INTEGER NOT NULL DEFAULT 40000,
    "postalCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "counties" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sourceConfig" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Market_orgId_isEnabled_idx" ON "Market"("orgId", "isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "Market_orgId_slug_key" ON "Market"("orgId", "slug");

-- CreateIndex
CREATE INDEX "DiscoverySignal_orgId_origin_observedAt_idx" ON "DiscoverySignal"("orgId", "origin", "observedAt");

-- CreateIndex
CREATE INDEX "DiscoverySignal_orgId_marketId_status_idx" ON "DiscoverySignal"("orgId", "marketId", "status");

-- AddForeignKey
ALTER TABLE "Market" ADD CONSTRAINT "Market_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSource" ADD CONSTRAINT "DataSource_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoverySignal" ADD CONSTRAINT "DiscoverySignal_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill provenance for rows that predate the column.
--
-- Everything defaults to SEED_DEMO, which is right for a database that has only
-- ever held the demonstration seed. It is wrong for anyone who already used the
-- CSV importer: their real companies would be labelled fabricated and hidden
-- behind a "demo data" warning.
--
-- Companies created at or after an organisation's first recorded CSV import are
-- reclassified. Discovery-created companies always carry SourceEvidence and
-- seeded ones predate the import, so the window is a safe discriminator.
UPDATE "Company" c
SET "origin" = 'IMPORTED'
WHERE c."createdAt" >= (
  SELECT MIN(a."createdAt")
  FROM "AuditEvent" a
  WHERE a."orgId" = c."orgId" AND a."action" = 'import.csv'
)
AND NOT EXISTS (
  SELECT 1 FROM "SourceEvidence" e WHERE e."companyId" = c."id"
);
