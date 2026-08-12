-- Measurement: experiments, versioned processes, and four more funnel rungs.
--
-- Additive only. The new OutcomeStage values are appended, which means the
-- Postgres enum's own sort order no longer matches the funnel's order — so
-- nothing may sort by this type. The order lives in one exported array in
-- lib/measure/funnel.ts and a test asserts the two agree.
--
-- Hand-written at the end: a partial unique index giving each process key one
-- active version, and a check keeping arm weights inside 0..1. Prisma can
-- express neither.

-- CreateEnum
CREATE TYPE "ExperimentState" AS ENUM ('DRAFT', 'RUNNING', 'HALTED', 'CONCLUDED');

-- CreateEnum
CREATE TYPE "ExperimentSubject" AS ENUM ('CALL_SCRIPT', 'PROOF_STEP', 'OUTREACH_COPY', 'QUEUE_ORDER', 'AUDIENCE_ORDER');

-- CreateEnum
CREATE TYPE "ProcessKind" AS ENUM ('CALL_SCRIPT', 'OUTREACH_COPY', 'PROOF_STEP_POLICY', 'BRIEF_PROMPT', 'SUMMARY_PROMPT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OutcomeStage" ADD VALUE 'RELEVANT_PERSON';
ALTER TYPE "OutcomeStage" ADD VALUE 'NEED_CONFIRMED';
ALTER TYPE "OutcomeStage" ADD VALUE 'QUOTE_REQUESTED';
ALTER TYPE "OutcomeStage" ADD VALUE 'PROOF_STEP_ACCEPTED';

-- CreateTable
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "subject" "ExperimentSubject" NOT NULL,
    "state" "ExperimentState" NOT NULL DEFAULT 'DRAFT',
    "primaryOutcome" "OutcomeStage" NOT NULL,
    "guardrails" "OutcomeStage"[] DEFAULT ARRAY[]::"OutcomeStage"[],
    "minimumSamplePerArm" INTEGER NOT NULL DEFAULT 30,
    "tiers" "LeadTier"[] DEFAULT ARRAY[]::"LeadTier"[],
    "routes" "SignalCategory"[] DEFAULT ARRAY[]::"SignalCategory"[],
    "markets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startedAt" TIMESTAMP(3),
    "concludedAt" TIMESTAMP(3),
    "conclusion" TEXT,
    "winningArmId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperimentArm" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isControl" BOOLEAN NOT NULL DEFAULT false,
    "processVersionId" TEXT,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentArm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperimentAssignment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "armId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "stratum" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessVersion" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" "ProcessKind" NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "declaredVariables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "isFallback" BOOLEAN NOT NULL DEFAULT false,
    "supersededById" TEXT,
    "retiredAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Experiment_winningArmId_key" ON "Experiment"("winningArmId");

-- CreateIndex
CREATE INDEX "Experiment_orgId_state_idx" ON "Experiment"("orgId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ExperimentArm_experimentId_key_key" ON "ExperimentArm"("experimentId", "key");

-- CreateIndex
CREATE INDEX "ExperimentAssignment_orgId_experimentId_armId_idx" ON "ExperimentAssignment"("orgId", "experimentId", "armId");

-- CreateIndex
CREATE UNIQUE INDEX "ExperimentAssignment_experimentId_subjectType_subjectId_key" ON "ExperimentAssignment"("experimentId", "subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessVersion_supersededById_key" ON "ProcessVersion"("supersededById");

-- CreateIndex
CREATE INDEX "ProcessVersion_orgId_kind_isActive_idx" ON "ProcessVersion"("orgId", "kind", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessVersion_orgId_kind_key_version_key" ON "ProcessVersion"("orgId", "kind", "key", "version");

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentArm" ADD CONSTRAINT "ExperimentArm_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentArm" ADD CONSTRAINT "ExperimentArm_processVersionId_fkey" FOREIGN KEY ("processVersionId") REFERENCES "ProcessVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentAssignment" ADD CONSTRAINT "ExperimentAssignment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentAssignment" ADD CONSTRAINT "ExperimentAssignment_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentAssignment" ADD CONSTRAINT "ExperimentAssignment_armId_fkey" FOREIGN KEY ("armId") REFERENCES "ExperimentArm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessVersion" ADD CONSTRAINT "ProcessVersion_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessVersion" ADD CONSTRAINT "ProcessVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessVersion" ADD CONSTRAINT "ProcessVersion_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "ProcessVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Invariants Prisma cannot express
-- ---------------------------------------------------------------------------

-- One live version per process key. Two actives means "which script produced
-- these numbers" has two answers, which is the same as having none.
CREATE UNIQUE INDEX "ProcessVersion_one_active_per_key"
  ON "ProcessVersion" ("orgId", "kind", "key")
  WHERE "isActive" = true;

-- One shipped fallback per key, so there is always exactly one safe thing to
-- fall back to rather than an arbitrary pick among several.
CREATE UNIQUE INDEX "ProcessVersion_one_fallback_per_key"
  ON "ProcessVersion" ("orgId", "kind", "key")
  WHERE "isFallback" = true;

-- A weight outside 0..1 is not a share of traffic.
ALTER TABLE "ExperimentArm"
  ADD CONSTRAINT "ExperimentArm_weight_is_a_share" CHECK ("weight" >= 0 AND "weight" <= 1);

-- A sample floor of zero would let a readout name a winner from one
-- observation, which is the specific failure this column exists to prevent.
ALTER TABLE "Experiment"
  ADD CONSTRAINT "Experiment_minimum_sample_is_meaningful" CHECK ("minimumSamplePerArm" >= 1);
