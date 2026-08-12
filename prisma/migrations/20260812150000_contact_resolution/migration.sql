-- CreateEnum
CREATE TYPE "ContactResolutionStatus" AS ENUM ('QUEUED', 'IN_PROGRESS', 'RESOLVED', 'AMBIGUOUS', 'UNRESOLVED', 'FAILED');

-- CreateEnum
CREATE TYPE "ContactConfidence" AS ENUM ('VERIFIED', 'PROBABLE', 'AMBIGUOUS', 'UNRESOLVED', 'FAILED');

-- CreateEnum
CREATE TYPE "ContactScope" AS ENUM ('LOCATION', 'PARENT_OR_CENTRAL', 'UNKNOWN');

-- CreateTable
CREATE TABLE "ContactResolution" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "status" "ContactResolutionStatus" NOT NULL DEFAULT 'QUEUED',
    "confidence" "ContactConfidence",
    "blocker" TEXT,
    "sourcesAttempted" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastSources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "transientFailures" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "candidates" JSONB NOT NULL DEFAULT '[]',
    "ambiguityReason" TEXT,
    "failureKind" TEXT,
    "failureDetail" TEXT,
    "fixInstruction" TEXT,
    "rejectedValues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactResolution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactProvenance" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "externalId" TEXT,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confidence" "ContactConfidence" NOT NULL,
    "scope" "ContactScope" NOT NULL DEFAULT 'UNKNOWN',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "enteredByOperator" BOOLEAN NOT NULL DEFAULT false,
    "matchMethod" TEXT,
    "supersededAt" TIMESTAMP(3),
    "supersededReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactProvenance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContactResolution_companyId_key" ON "ContactResolution"("companyId");

-- CreateIndex
CREATE INDEX "ContactResolution_orgId_status_nextAttemptAt_idx" ON "ContactResolution"("orgId", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "ContactResolution_orgId_status_lockedAt_idx" ON "ContactResolution"("orgId", "status", "lockedAt");

-- CreateIndex
CREATE INDEX "ContactProvenance_orgId_companyId_field_idx" ON "ContactProvenance"("orgId", "companyId", "field");

-- CreateIndex
CREATE UNIQUE INDEX "ContactProvenance_companyId_field_value_key" ON "ContactProvenance"("companyId", "field", "value");

-- AddForeignKey
ALTER TABLE "ContactResolution" ADD CONSTRAINT "ContactResolution_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactResolution" ADD CONSTRAINT "ContactResolution_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactProvenance" ADD CONSTRAINT "ContactProvenance_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactProvenance" ADD CONSTRAINT "ContactProvenance_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

