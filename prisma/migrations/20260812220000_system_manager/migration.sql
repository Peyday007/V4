-- CreateEnum
CREATE TYPE "WorkCapability" AS ENUM ('CALL_PLACING', 'CALL_RECORDING', 'REQUIREMENT_CAPTURE', 'QUOTE_DRAFTING', 'DEAL_ROOM_SENDING', 'PROVIDER_COMMITMENT', 'AUTONOMOUS_SENDING');

-- CreateEnum
CREATE TYPE "InterventionRung" AS ENUM ('INLINE_GUIDANCE', 'REQUIRED_CORRECTION', 'MICRO_COACHING', 'WARNING', 'RESTRICTED_MODE', 'CAPABILITY_PAUSE', 'SECURITY_RESTRICTION', 'OWNER_ESCALATION');

-- CreateEnum
CREATE TYPE "InterventionState" AS ENUM ('SHADOW', 'PROPOSED', 'ACTIVE', 'LIFTED', 'WITHDRAWN', 'DECLINED');

-- CreateEnum
CREATE TYPE "FaultAttribution" AS ENUM ('SYSTEM_FAULT', 'OPERATOR', 'UNDETERMINED');

-- CreateEnum
CREATE TYPE "ConsistencyKind" AS ENUM ('ATTEMPT_WITHOUT_EVIDENCE', 'PROMISE_NOT_SCHEDULED', 'DISPOSITION_CONTRADICTS_TRANSCRIPT', 'QUALIFIED_WITHOUT_FACTS', 'DUPLICATE_ATTEMPT', 'ATTEMPT_OUTSIDE_CALLING_HOURS', 'FACTS_RECORDED_WITHOUT_CONTACT', 'FOLLOW_UP_PROMISE_MISSED');

-- CreateEnum
CREATE TYPE "CaseState" AS ENUM ('OPEN', 'EXPLAINED', 'SYSTEM_FAULT', 'CONFIRMED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ReadinessState" AS ENUM ('READY', 'READY_WITH_WARNINGS', 'BLOCKED_BY_SYSTEM', 'BLOCKED_BY_RESTRICTION', 'NOTHING_TO_DO');

-- CreateEnum
CREATE TYPE "BreakerState" AS ENUM ('CLOSED', 'OPEN');

-- CreateEnum
CREATE TYPE "BriefPeriod" AS ENUM ('DAILY', 'WEEKLY');

-- CreateTable
CREATE TABLE "Intervention" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "callerId" TEXT,
    "routeId" TEXT,
    "caseId" TEXT,
    "rung" "InterventionRung" NOT NULL,
    "state" "InterventionState" NOT NULL DEFAULT 'SHADOW',
    "capability" "WorkCapability",
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "attribution" "FaultAttribution" NOT NULL,
    "restorationRule" TEXT,
    "restorationEvidence" JSONB NOT NULL DEFAULT '[]',
    "producedBy" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "shadow" BOOLEAN NOT NULL DEFAULT true,
    "enforcedAt" TIMESTAMP(3),
    "liftedAt" TIMESTAMP(3),
    "liftedById" TEXT,
    "liftedBecause" TEXT,
    "overriddenById" TEXT,
    "overriddenAt" TIMESTAMP(3),
    "overrideReason" TEXT,
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Intervention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CircuitBreaker" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "capability" "WorkCapability" NOT NULL,
    "state" "BreakerState" NOT NULL DEFAULT 'CLOSED',
    "openedAt" TIMESTAMP(3),
    "openedBecause" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "observedCount" INTEGER NOT NULL DEFAULT 0,
    "windowMinutes" INTEGER NOT NULL DEFAULT 60,
    "retryAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closedBecause" TEXT,
    "incidentId" TEXT,
    "producedBy" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CircuitBreaker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsistencyCase" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "callerId" TEXT,
    "routeId" TEXT,
    "attemptId" TEXT,
    "sessionId" TEXT,
    "kind" "ConsistencyKind" NOT NULL,
    "state" "CaseState" NOT NULL DEFAULT 'OPEN',
    "dedupeKey" TEXT NOT NULL,
    "observed" TEXT NOT NULL,
    "expected" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "benignAlternatives" JSONB NOT NULL DEFAULT '[]',
    "attribution" "FaultAttribution" NOT NULL DEFAULT 'UNDETERMINED',
    "producedBy" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "question" TEXT,
    "askedAt" TIMESTAMP(3),
    "answer" TEXT,
    "answeredAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsistencyCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftReadiness" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "callerId" TEXT NOT NULL,
    "shiftDate" DATE NOT NULL,
    "state" "ReadinessState" NOT NULL,
    "blockers" JSONB NOT NULL DEFAULT '[]',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "workReady" INTEGER NOT NULL DEFAULT 0,
    "duePromises" INTEGER NOT NULL DEFAULT 0,
    "openCases" INTEGER NOT NULL DEFAULT 0,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "producedBy" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,

    CONSTRAINT "ShiftReadiness_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagerBrief" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "period" "BriefPeriod" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "headline" TEXT NOT NULL,
    "sections" JSONB NOT NULL DEFAULT '[]',
    "ownerDecisions" JSONB NOT NULL DEFAULT '[]',
    "strengths" JSONB NOT NULL DEFAULT '[]',
    "withheld" JSONB NOT NULL DEFAULT '[]',
    "producedBy" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagerBrief_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Intervention_orgId_state_rung_idx" ON "Intervention"("orgId", "state", "rung");

-- CreateIndex
CREATE INDEX "Intervention_callerId_state_idx" ON "Intervention"("callerId", "state");

-- CreateIndex
CREATE INDEX "CircuitBreaker_orgId_state_capability_idx" ON "CircuitBreaker"("orgId", "state", "capability");

-- CreateIndex
CREATE INDEX "ConsistencyCase_orgId_state_kind_idx" ON "ConsistencyCase"("orgId", "state", "kind");

-- CreateIndex
CREATE INDEX "ConsistencyCase_callerId_state_idx" ON "ConsistencyCase"("callerId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ConsistencyCase_orgId_kind_dedupeKey_key" ON "ConsistencyCase"("orgId", "kind", "dedupeKey");

-- CreateIndex
CREATE INDEX "ShiftReadiness_orgId_shiftDate_idx" ON "ShiftReadiness"("orgId", "shiftDate");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftReadiness_callerId_shiftDate_key" ON "ShiftReadiness"("callerId", "shiftDate");

-- CreateIndex
CREATE INDEX "ManagerBrief_orgId_generatedAt_idx" ON "ManagerBrief"("orgId", "generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ManagerBrief_orgId_period_periodStart_key" ON "ManagerBrief"("orgId", "period", "periodStart");

-- AddForeignKey
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "RouteHypothesis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ConsistencyCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_liftedById_fkey" FOREIGN KEY ("liftedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_overriddenById_fkey" FOREIGN KEY ("overriddenById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircuitBreaker" ADD CONSTRAINT "CircuitBreaker_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircuitBreaker" ADD CONSTRAINT "CircuitBreaker_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsistencyCase" ADD CONSTRAINT "ConsistencyCase_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsistencyCase" ADD CONSTRAINT "ConsistencyCase_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsistencyCase" ADD CONSTRAINT "ConsistencyCase_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "RouteHypothesis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsistencyCase" ADD CONSTRAINT "ConsistencyCase_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftReadiness" ADD CONSTRAINT "ShiftReadiness_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftReadiness" ADD CONSTRAINT "ShiftReadiness_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerBrief" ADD CONSTRAINT "ManagerBrief_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The rules the database keeps, because code forgets.
-- ---------------------------------------------------------------------------

-- A system failure can never name a caller.
--
-- The single most important line in this migration. "System failure never
-- counts as VA misconduct" is a promise to a person whose pay and standing
-- depend on it, and a promise kept only by whichever code path happens to run
-- is not kept. A dropped save, a dialer outage or a transcription failure has
-- nowhere to put a caller's id on this table at all.
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_system_faults_are_never_a_persons_fault"
  CHECK (NOT ("attribution" = 'SYSTEM_FAULT' AND "callerId" IS NOT NULL));

-- Anything that stops work names exactly what it stops.
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_a_stop_names_what_it_stops"
  CHECK ("rung" NOT IN ('RESTRICTED_MODE', 'CAPABILITY_PAUSE', 'SECURITY_RESTRICTION')
         OR "capability" IS NOT NULL);

-- Restoration conditions are written before the restriction, never after.
-- Afterwards everybody is invested in it staying, and "we will see how they get
-- on" is how a temporary restriction becomes a permanent one.
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_restrictions_define_their_own_end"
  CHECK ("rung" NOT IN ('RESTRICTED_MODE', 'CAPABILITY_PAUSE', 'SECURITY_RESTRICTION')
         OR ("restorationRule" IS NOT NULL AND length(btrim("restorationRule")) > 0));

-- A warning or worse has to point at the records it was read from. A sanction
-- whose evidence is "the system says so" cannot be checked or appealed.
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_serious_rungs_name_their_records"
  CHECK ("rung" IN ('INLINE_GUIDANCE', 'REQUIRED_CORRECTION', 'MICRO_COACHING')
         OR jsonb_array_length("evidence") > 0);

-- Shadow mode means shadow mode. A row marked as calibration has no effect on
-- anybody's day, and the two fields cannot drift apart.
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_shadow_never_enforces"
  CHECK (NOT ("shadow" = true AND "enforcedAt" IS NOT NULL));

ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_enforcement_implies_a_live_state"
  CHECK ("enforcedAt" IS NULL OR "state" IN ('ACTIVE', 'LIFTED', 'WITHDRAWN'));

-- Lifting is evidence-based and audited: it cannot happen without a date and a
-- sentence saying what changed.
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_lifting_is_explained"
  CHECK ("state" <> 'LIFTED'
         OR ("liftedAt" IS NOT NULL AND "liftedBecause" IS NOT NULL AND length(btrim("liftedBecause")) > 0));

ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_confidence_is_a_probability"
  CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));

ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_producer_is_named"
  CHECK (length(btrim("producedBy")) > 0 AND length(btrim("ruleVersion")) > 0);

-- One live restriction per capability per person. Two half-forgotten pauses on
-- the same capability is how somebody stays stopped after the first was lifted.
CREATE UNIQUE INDEX "Intervention_one_live_restriction_per_capability_key"
  ON "Intervention" ("callerId", "capability")
  WHERE "state" = 'ACTIVE' AND "shadow" = false AND "callerId" IS NOT NULL AND "capability" IS NOT NULL;

-- ---------------------------------------------------------------------------

-- An open breaker says why, and a closed one says what changed.
ALTER TABLE "CircuitBreaker" ADD CONSTRAINT "CircuitBreaker_open_states_its_reason"
  CHECK ("state" <> 'OPEN'
         OR ("openedAt" IS NOT NULL AND "openedBecause" IS NOT NULL AND length(btrim("openedBecause")) > 0));

ALTER TABLE "CircuitBreaker" ADD CONSTRAINT "CircuitBreaker_closing_is_explained"
  CHECK ("closedAt" IS NULL OR ("closedBecause" IS NOT NULL AND length(btrim("closedBecause")) > 0));

-- The failure count cannot exceed what was observed, because a rate above one
-- is the signature of a counter being incremented in two places.
ALTER TABLE "CircuitBreaker" ADD CONSTRAINT "CircuitBreaker_failures_fit_inside_observations"
  CHECK ("failureCount" >= 0 AND "observedCount" >= 0 AND "failureCount" <= "observedCount");

ALTER TABLE "CircuitBreaker" ADD CONSTRAINT "CircuitBreaker_window_is_positive"
  CHECK ("windowMinutes" > 0);

CREATE UNIQUE INDEX "CircuitBreaker_one_open_per_capability_key"
  ON "CircuitBreaker" ("orgId", "capability") WHERE "state" = 'OPEN';

-- ---------------------------------------------------------------------------

-- Every case carries at least one ordinary, innocent explanation for the same
-- observation. This is the structural form of "identifies mismatches and benign
-- alternatives; it does not infer intent or label someone a liar" — a check
-- that cannot name a way it could be nothing is a check that is not ready to be
-- shown to the person it is about.
ALTER TABLE "ConsistencyCase" ADD CONSTRAINT "ConsistencyCase_offers_a_benign_explanation"
  CHECK (jsonb_array_length("benignAlternatives") > 0);

ALTER TABLE "ConsistencyCase" ADD CONSTRAINT "ConsistencyCase_names_its_evidence"
  CHECK (jsonb_array_length("evidence") > 0);

ALTER TABLE "ConsistencyCase" ADD CONSTRAINT "ConsistencyCase_confidence_is_a_probability"
  CHECK ("confidence" >= 0 AND "confidence" <= 1);

ALTER TABLE "ConsistencyCase" ADD CONSTRAINT "ConsistencyCase_closing_is_explained"
  CHECK ("state" = 'OPEN'
         OR ("resolvedAt" IS NOT NULL AND "resolution" IS NOT NULL AND length(btrim("resolution")) > 0));

-- An answer has a question and a time. A recorded reply to a question nobody
-- asked is the shape of an explanation invented after the fact.
ALTER TABLE "ConsistencyCase" ADD CONSTRAINT "ConsistencyCase_an_answer_needs_a_question"
  CHECK ("answer" IS NULL OR ("question" IS NOT NULL AND "askedAt" IS NOT NULL AND "answeredAt" IS NOT NULL));

ALTER TABLE "ConsistencyCase" ADD CONSTRAINT "ConsistencyCase_producer_is_named"
  CHECK (length(btrim("producedBy")) > 0 AND length(btrim("ruleVersion")) > 0);

-- ---------------------------------------------------------------------------

-- A blocked shift says what is blocking it. "You cannot work today" with no
-- reason is the worst message this system could send a person.
ALTER TABLE "ShiftReadiness" ADD CONSTRAINT "ShiftReadiness_blocked_says_why"
  CHECK ("state" NOT IN ('BLOCKED_BY_SYSTEM', 'BLOCKED_BY_RESTRICTION')
         OR jsonb_array_length("blockers") > 0);

ALTER TABLE "ShiftReadiness" ADD CONSTRAINT "ShiftReadiness_warnings_are_warnings"
  CHECK ("state" <> 'READY_WITH_WARNINGS' OR jsonb_array_length("warnings") > 0);

ALTER TABLE "ShiftReadiness" ADD CONSTRAINT "ShiftReadiness_counts_are_not_negative"
  CHECK ("workReady" >= 0 AND "duePromises" >= 0 AND "openCases" >= 0);

-- ---------------------------------------------------------------------------

ALTER TABLE "ManagerBrief" ADD CONSTRAINT "ManagerBrief_period_runs_forwards"
  CHECK ("periodEnd" > "periodStart");

ALTER TABLE "ManagerBrief" ADD CONSTRAINT "ManagerBrief_has_a_headline"
  CHECK (length(btrim("headline")) > 0);
