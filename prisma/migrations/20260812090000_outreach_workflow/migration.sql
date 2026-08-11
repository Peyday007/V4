-- Outreach: what happened when somebody actually worked the opportunity.
--
-- Separate from RouteHypothesis.status, which is the engine's judgement about
-- the opportunity. This is the operator's. The engine can say PURSUE while the
-- operator has left three voicemails, and neither fact should overwrite the
-- other — nor should either overwrite the source evidence underneath both.

CREATE TYPE "OutreachStatus" AS ENUM (
  'NEW', 'ATTEMPTED', 'IN_CONVERSATION', 'FOLLOW_UP', 'QUALIFIED',
  'CLOSED_HANDLED', 'CLOSED_NOT_INTERESTED', 'CLOSED_BAD_FIT', 'DO_NOT_CONTACT'
);

CREATE TYPE "CallDisposition" AS ENUM (
  'NO_ANSWER', 'LEFT_VOICEMAIL', 'GATEKEEPER', 'WRONG_NUMBER',
  'REACHED_DECISION_MAKER', 'INTERESTED', 'NEEDS_INFORMATION', 'FOLLOW_UP',
  'QUALIFIED_OPPORTUNITY', 'ALREADY_HANDLED', 'NOT_INTERESTED', 'BAD_FIT',
  'DO_NOT_CONTACT'
);

CREATE TABLE "OutreachState" (
  "id"              TEXT NOT NULL,
  "orgId"           TEXT NOT NULL,
  "routeId"         TEXT NOT NULL,
  "status"          "OutreachStatus" NOT NULL DEFAULT 'NEW',
  -- Out of the calling queue until this passes. The single field that makes
  -- "follow up on Tuesday" mean anything.
  "snoozeUntil"     TIMESTAMP(3),
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt"   TIMESTAMP(3),
  "lastDisposition" "CallDisposition",
  -- Learned on a call. Kept apart from the event's evidence, which belongs to
  -- the source and is never rewritten by an operator.
  "contactName"      TEXT,
  "contactRole"      TEXT,
  "correctedPhone"   TEXT,
  "correctedEmail"   TEXT,
  "confirmedNeed"    TEXT,
  "confirmedTiming"  TEXT,
  "budgetNote"       TEXT,
  "incumbentStatus"  TEXT,
  "preferredRoute"   "SignalCategory",
  "disqualifyReason" TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OutreachState_pkey" PRIMARY KEY ("id")
);

-- One state per route. The constraint is what makes a concurrent save from two
-- browser tabs converge instead of forking.
CREATE UNIQUE INDEX "OutreachState_routeId_key" ON "OutreachState"("routeId");
CREATE INDEX "OutreachState_orgId_status_snoozeUntil_idx" ON "OutreachState"("orgId", "status", "snoozeUntil");

-- Append-only. Rows are inserted and never updated or deleted, so the history
-- of what was tried survives every later correction.
CREATE TABLE "OutreachAttempt" (
  "id"              TEXT NOT NULL,
  "orgId"           TEXT NOT NULL,
  "routeId"         TEXT NOT NULL,
  "userId"          TEXT,
  "disposition"     "CallDisposition" NOT NULL,
  "notes"           TEXT,
  -- What the operator saw at the time, so a later engine change cannot make
  -- the record of the call disagree with the call.
  "contextSnapshot" JSONB NOT NULL DEFAULT '{}',
  "occurredAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OutreachAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OutreachAttempt_orgId_occurredAt_idx" ON "OutreachAttempt"("orgId", "occurredAt");
CREATE INDEX "OutreachAttempt_routeId_occurredAt_idx" ON "OutreachAttempt"("routeId", "occurredAt");

ALTER TABLE "OutreachState" ADD CONSTRAINT "OutreachState_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutreachState" ADD CONSTRAINT "OutreachState_routeId_fkey"
  FOREIGN KEY ("routeId") REFERENCES "RouteHypothesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutreachAttempt" ADD CONSTRAINT "OutreachAttempt_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutreachAttempt" ADD CONSTRAINT "OutreachAttempt_routeId_fkey"
  FOREIGN KEY ("routeId") REFERENCES "RouteHypothesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutreachAttempt" ADD CONSTRAINT "OutreachAttempt_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
