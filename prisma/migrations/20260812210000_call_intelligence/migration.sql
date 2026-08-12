-- Call intelligence: sessions, transcripts, insights and review.
--
-- Additive only.
--
-- The hand-written constraints at the end are the point of this migration.
-- The directive's rule is that a recording row must never imply audio exists,
-- and application code alone cannot promise that — a later feature, a fixture
-- or a careless backfill would eventually write a storage key onto a row whose
-- audio was never captured, and a screen would then offer a play button for a
-- file nobody has. So the database refuses it, in both directions.

-- CreateEnum
CREATE TYPE "CaptureMode" AS ENUM ('PROVIDER_RECORDING', 'INTERIM_ROOM_AUDIO', 'NONE');

-- CreateEnum
CREATE TYPE "RecordingState" AS ENUM ('NOT_ATTEMPTED', 'BLOCKED_BY_JURISDICTION', 'CONSENT_REFUSED', 'CAPTURING', 'STORED', 'FAILED', 'RETENTION_EXPIRED', 'DELETED_ON_REQUEST');

-- CreateEnum
CREATE TYPE "ConsentState" AS ENUM ('UNKNOWN', 'NOT_REQUIRED', 'ANNOUNCED', 'GRANTED', 'REFUSED');

-- CreateEnum
CREATE TYPE "TranscriptState" AS ENUM ('NOT_ATTEMPTED', 'QUEUED', 'PROCESSING', 'READY', 'FAILED', 'NO_AUDIO');

-- CreateEnum
CREATE TYPE "InsightKind" AS ENUM ('PERSON_REACHED', 'CONFIRMED_NEED', 'SCOPE', 'TIMING', 'PROCESS', 'OBJECTION', 'INCUMBENT', 'BUYER_PROMISE', 'PROVIDER_PROMISE', 'NEXT_ACTION', 'QUALIFICATION_FIELD', 'ROUTE_FIT', 'SCRIPT_OBSERVATION', 'DISPOSITION_SUGGESTION');

-- CreateEnum
CREATE TYPE "InsightState" AS ENUM ('AUTO_APPLIED', 'NEEDS_REVIEW', 'CONFIRMED', 'CORRECTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReviewReason" AS ENUM ('LOW_CONFIDENCE', 'HIGH_IMPACT', 'RANDOM_SAMPLE', 'OPERATOR_FLAGGED', 'DISAGREEMENT');

-- CreateEnum
CREATE TYPE "ReviewState" AS ENUM ('OPEN', 'DONE', 'ABANDONED');

-- CreateTable
CREATE TABLE "CallSession" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "callerId" TEXT,
    "contactId" TEXT,
    "attemptId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "providerCallId" TEXT,
    "providerStatus" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "durationSec" INTEGER,
    "captureMode" "CaptureMode" NOT NULL DEFAULT 'NONE',
    "recordingState" "RecordingState" NOT NULL DEFAULT 'NOT_ATTEMPTED',
    "storageKey" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "consentState" "ConsentState" NOT NULL DEFAULT 'UNKNOWN',
    "consentBasis" TEXT,
    "announcementText" TEXT,
    "callerJurisdiction" TEXT,
    "prospectJurisdiction" TEXT,
    "retentionUntil" TIMESTAMP(3),
    "failureReason" TEXT,
    "transcriptState" "TranscriptState" NOT NULL DEFAULT 'NOT_ATTEMPTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallTranscript" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "state" "TranscriptState" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT,
    "modelName" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "text" TEXT,
    "segments" JSONB NOT NULL DEFAULT '[]',
    "redactions" JSONB NOT NULL DEFAULT '[]',
    "speakerSeparated" BOOLEAN NOT NULL DEFAULT false,
    "failureReason" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallTranscript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallInsight" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" "InsightKind" NOT NULL,
    "value" TEXT NOT NULL,
    "valueJson" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidenceQuote" TEXT,
    "evidenceStartSec" INTEGER,
    "state" "InsightState" NOT NULL DEFAULT 'NEEDS_REVIEW',
    "reviewReason" TEXT,
    "actor" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "correctedValue" TEXT,
    "correctionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallReview" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "reason" "ReviewReason" NOT NULL,
    "state" "ReviewState" NOT NULL DEFAULT 'OPEN',
    "because" TEXT NOT NULL,
    "assignedToId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "reviewerId" TEXT,
    "notes" TEXT,
    "correctionsMade" INTEGER NOT NULL DEFAULT 0,
    "agreed" BOOLEAN,

    CONSTRAINT "CallReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CallSession_attemptId_key" ON "CallSession"("attemptId");

-- CreateIndex
CREATE INDEX "CallSession_orgId_recordingState_idx" ON "CallSession"("orgId", "recordingState");

-- CreateIndex
CREATE INDEX "CallSession_routeId_startedAt_idx" ON "CallSession"("routeId", "startedAt");

-- CreateIndex
CREATE INDEX "CallSession_retentionUntil_idx" ON "CallSession"("retentionUntil");

-- CreateIndex
CREATE UNIQUE INDEX "CallTranscript_sessionId_key" ON "CallTranscript"("sessionId");

-- CreateIndex
CREATE INDEX "CallInsight_orgId_state_idx" ON "CallInsight"("orgId", "state");

-- CreateIndex
CREATE INDEX "CallInsight_sessionId_kind_idx" ON "CallInsight"("sessionId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "CallReview_sessionId_key" ON "CallReview"("sessionId");

-- CreateIndex
CREATE INDEX "CallReview_orgId_state_reason_idx" ON "CallReview"("orgId", "state", "reason");

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "RouteHypothesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "OutreachAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallTranscript" ADD CONSTRAINT "CallTranscript_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallTranscript" ADD CONSTRAINT "CallTranscript_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CallSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallInsight" ADD CONSTRAINT "CallInsight_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallInsight" ADD CONSTRAINT "CallInsight_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CallSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallInsight" ADD CONSTRAINT "CallInsight_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallReview" ADD CONSTRAINT "CallReview_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallReview" ADD CONSTRAINT "CallReview_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CallSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallReview" ADD CONSTRAINT "CallReview_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallReview" ADD CONSTRAINT "CallReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Invariants Prisma cannot express
-- ---------------------------------------------------------------------------

-- Audio exists if and only if the row says it was stored. Both directions:
-- a key without STORED is a claim about a file nobody has, and STORED without
-- a key is a promise the storage layer cannot keep.
ALTER TABLE "CallSession"
  ADD CONSTRAINT "CallSession_audio_matches_state"
  CHECK (("recordingState" = 'STORED') = ("storageKey" IS NOT NULL));

-- A failure has to say what failed. "Failed" on its own is the kind of state
-- that gets rediscovered three weeks later by somebody reading rows by hand.
ALTER TABLE "CallSession"
  ADD CONSTRAINT "CallSession_failure_has_a_reason"
  CHECK ("recordingState" <> 'FAILED' OR "failureReason" IS NOT NULL);

-- Stored audio must have a deletion date. A recording of a named person with
-- no retention date is one nobody ever decides to delete.
ALTER TABLE "CallSession"
  ADD CONSTRAINT "CallSession_stored_audio_expires"
  CHECK ("recordingState" <> 'STORED' OR "retentionUntil" IS NOT NULL);

-- Negative durations are not short calls.
ALTER TABLE "CallSession"
  ADD CONSTRAINT "CallSession_duration_is_not_negative"
  CHECK ("durationSec" IS NULL OR "durationSec" >= 0);

-- Confidence is a probability.
ALTER TABLE "CallInsight"
  ADD CONSTRAINT "CallInsight_confidence_is_a_probability"
  CHECK ("confidence" >= 0 AND "confidence" <= 1);

-- Every conclusion names who reached it. An unattributed one cannot be argued
-- with, and this system's whole claim is that its conclusions can be.
ALTER TABLE "CallInsight"
  ADD CONSTRAINT "CallInsight_actor_is_named"
  CHECK (length(btrim("actor")) > 0);

-- A ready transcript has text; a failed one has a reason. Neither state is
-- allowed to be empty and look complete.
ALTER TABLE "CallTranscript"
  ADD CONSTRAINT "CallTranscript_ready_has_text"
  CHECK ("state" <> 'READY' OR ("text" IS NOT NULL AND length(btrim("text")) > 0));

ALTER TABLE "CallTranscript"
  ADD CONSTRAINT "CallTranscript_failure_has_a_reason"
  CHECK ("state" <> 'FAILED' OR "failureReason" IS NOT NULL);

-- Interim room audio is one mixed channel. It cannot be speaker-separated,
-- whatever a provider's response claims, and a transcript that labels speakers
-- from it is guessing at who said what.
--
-- A trigger rather than a check constraint, because the rule depends on
-- another table and Postgres will not allow a subquery in a CHECK. The
-- enforcement matters more than the mechanism: this is the difference between
-- a quote attributed to the buyer and a quote attributed to whoever the
-- transcriber guessed, and the second one ends up in a deal record.
CREATE OR REPLACE FUNCTION "callTranscriptSeparationGuard"() RETURNS trigger AS $$
DECLARE
  mode "CaptureMode";
BEGIN
  IF NEW."speakerSeparated" IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  SELECT s."captureMode" INTO mode FROM "CallSession" s WHERE s."id" = NEW."sessionId";

  IF mode IS DISTINCT FROM 'PROVIDER_RECORDING' THEN
    RAISE EXCEPTION
      'speakerSeparated requires a provider recording; this session captured % ', COALESCE(mode::text, 'nothing')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CallTranscript_separation_needs_separate_channels"
  BEFORE INSERT OR UPDATE ON "CallTranscript"
  FOR EACH ROW EXECUTE FUNCTION "callTranscriptSeparationGuard"();
