-- Deal progression: buyer requirement, provider workstream, economics, money.
--
-- Additive only. Nothing here alters or drops an existing column, so a
-- deployment that applies this migration before the new code ships leaves the
-- running application untouched.
--
-- Two things at the end of this file are hand-written because Prisma cannot
-- express them: the partial unique indexes that make "one current requirement",
-- "one selected provider", "one committed provider" and "one live quote" true
-- in the database rather than only in application code, and a check constraint
-- that keeps payment amounts positive so direction and kind stay the only
-- things carrying a sign.

-- CreateEnum
CREATE TYPE "BudgetMechanism" AS ENUM ('UNKNOWN', 'NO_BUDGET', 'BUDGET_STATED', 'QUOTE_REQUESTED', 'FORMAL_BID', 'RENEWAL_CYCLE');

-- CreateEnum
CREATE TYPE "RequirementState" AS ENUM ('DRAFT', 'CURRENT', 'SUPERSEDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ProviderWorkState" AS ENUM ('CANDIDATE_FOUND', 'CONTACTED', 'CAPABILITY_VERIFIED', 'AVAILABILITY_VERIFIED', 'COST_RECEIVED', 'SELECTED', 'COMMITTED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "QuoteState" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "EconomicsBasis" AS ENUM ('PRIOR', 'ESTIMATE', 'QUOTE', 'COMMITMENT', 'REALISED');

-- CreateEnum
CREATE TYPE "EconomicsConfidence" AS ENUM ('UNKNOWN', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "DealStage" AS ENUM ('COMMITTED', 'IN_DELIVERY', 'DELIVERED', 'INVOICED', 'PAID', 'CLOSED', 'CANCELLED', 'DISPUTED', 'LOST');

-- CreateEnum
CREATE TYPE "CommitmentBasis" AS ENUM ('VERBAL', 'EMAIL', 'PURCHASE_ORDER', 'SIGNED_CONTRACT');

-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('INVOICE', 'PAYMENT', 'REFUND', 'CHARGEBACK', 'WRITE_OFF');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApprovalType" ADD VALUE 'WORKING_CAPITAL';
ALTER TYPE "ApprovalType" ADD VALUE 'HIGH_RISK_FULFILMENT';

-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "routeId" TEXT,
ADD COLUMN     "routeQuoteId" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "routeId" TEXT;

-- CreateTable
CREATE TABLE "BuyerRequirement" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "state" "RequirementState" NOT NULL DEFAULT 'CURRENT',
    "summary" TEXT NOT NULL,
    "specification" TEXT,
    "quantity" TEXT,
    "unit" TEXT,
    "frequency" TEXT,
    "locationCount" INTEGER,
    "locations" TEXT,
    "startsAt" TIMESTAMP(3),
    "decisionBy" TIMESTAMP(3),
    "timingNote" TEXT,
    "processNotes" TEXT,
    "constraints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "incumbent" TEXT,
    "incumbentNotes" TEXT,
    "decisionMakerContactId" TEXT,
    "decisionMakerRole" TEXT,
    "authorityConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "budgetMechanism" "BudgetMechanism" NOT NULL DEFAULT 'UNKNOWN',
    "budgetAmount" DECIMAL(14,2),
    "budgetBasis" TEXT,
    "confirmedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceAttemptId" TEXT,
    "capturedById" TEXT,
    "capturedBy" TEXT NOT NULL DEFAULT 'caller',
    "supersededById" TEXT,
    "supersededAt" TIMESTAMP(3),
    "supersedeReason" TEXT,
    "withdrawnReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuyerRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCandidate" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "providerCompanyId" TEXT NOT NULL,
    "state" "ProviderWorkState" NOT NULL DEFAULT 'CANDIDATE_FOUND',
    "stateReason" TEXT,
    "stateChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "matchBasis" TEXT NOT NULL,
    "capabilityNotes" TEXT,
    "geographyNotes" TEXT,
    "capabilityVerifiedAt" TIMESTAMP(3),
    "capabilityEvidence" TEXT,
    "credentialsVerifiedAt" TIMESTAMP(3),
    "credentialsEvidence" TEXT,
    "availabilityVerifiedAt" TIMESTAMP(3),
    "availableFrom" TIMESTAMP(3),
    "availableUntil" TIMESTAMP(3),
    "capacityNotes" TEXT,
    "costAmount" DECIMAL(14,2),
    "costUnit" TEXT,
    "costBasis" TEXT,
    "costTerms" TEXT,
    "costReceivedAt" TIMESTAMP(3),
    "costExpiresAt" TIMESTAMP(3),
    "promiseText" TEXT,
    "promiseDueAt" TIMESTAMP(3),
    "promiseKeptAt" TIMESTAMP(3),
    "conflictNote" TEXT,
    "rejectedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteQuote" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "requirementId" TEXT NOT NULL,
    "providerCandidateId" TEXT,
    "state" "QuoteState" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "providerCost" DECIMAL(14,2),
    "freight" DECIMAL(14,2),
    "fees" DECIMAL(14,2),
    "contingency" DECIMAL(14,2),
    "buyerPrice" DECIMAL(14,2),
    "grossProfit" DECIMAL(14,2),
    "grossMarginPct" DOUBLE PRECISION,
    "basis" "EconomicsBasis" NOT NULL DEFAULT 'ESTIMATE',
    "confidence" "EconomicsConfidence" NOT NULL DEFAULT 'UNKNOWN',
    "costSideMissing" BOOLEAN NOT NULL DEFAULT true,
    "workingCapitalAmount" DECIMAL(14,2),
    "workingCapitalDays" INTEGER,
    "paymentTerms" TEXT,
    "deliveryTerms" TEXT,
    "downsideNotes" TEXT,
    "assumptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "validUntil" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "negotiationNote" TEXT,
    "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
    "approvalReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "supersededById" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RouteQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteDeal" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "stage" "DealStage" NOT NULL DEFAULT 'COMMITTED',
    "buyerCommittedAt" TIMESTAMP(3) NOT NULL,
    "buyerCommitmentBasis" "CommitmentBasis" NOT NULL,
    "buyerCommitmentEvidence" TEXT NOT NULL,
    "buyerContactId" TEXT,
    "contractedValue" DECIMAL(14,2),
    "providerCandidateId" TEXT,
    "providerCommittedAt" TIMESTAMP(3),
    "providerCommitmentBasis" "CommitmentBasis",
    "providerCommitmentEvidence" TEXT,
    "contractedCost" DECIMAL(14,2),
    "deliveryStartedAt" TIMESTAMP(3),
    "deliveryCompletedAt" TIMESTAMP(3),
    "completionEvidence" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "disputeOpenedAt" TIMESTAMP(3),
    "disputeNotes" TEXT,
    "responsibility" TEXT,
    "lostReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RouteDeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealMilestone" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "evidence" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealPayment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "direction" "PaymentDirection" NOT NULL,
    "kind" "PaymentKind" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "dueAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "reference" TEXT,
    "notes" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actorType" TEXT NOT NULL DEFAULT 'user',
    "actorId" TEXT,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT,
    "summary" TEXT NOT NULL,
    "before" JSONB NOT NULL DEFAULT '{}',
    "after" JSONB NOT NULL DEFAULT '{}',
    "evidence" TEXT,
    "confidence" TEXT,
    "correlationId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BuyerRequirement_supersededById_key" ON "BuyerRequirement"("supersededById");

-- CreateIndex
CREATE INDEX "BuyerRequirement_orgId_state_idx" ON "BuyerRequirement"("orgId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerRequirement_routeId_version_key" ON "BuyerRequirement"("routeId", "version");

-- CreateIndex
CREATE INDEX "ProviderCandidate_orgId_state_idx" ON "ProviderCandidate"("orgId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCandidate_routeId_providerCompanyId_key" ON "ProviderCandidate"("routeId", "providerCompanyId");

-- CreateIndex
CREATE UNIQUE INDEX "RouteQuote_supersededById_key" ON "RouteQuote"("supersededById");

-- CreateIndex
CREATE INDEX "RouteQuote_orgId_state_idx" ON "RouteQuote"("orgId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "RouteQuote_routeId_version_key" ON "RouteQuote"("routeId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "RouteDeal_routeId_key" ON "RouteDeal"("routeId");

-- CreateIndex
CREATE UNIQUE INDEX "RouteDeal_quoteId_key" ON "RouteDeal"("quoteId");

-- CreateIndex
CREATE INDEX "RouteDeal_orgId_stage_idx" ON "RouteDeal"("orgId", "stage");

-- CreateIndex
CREATE INDEX "DealMilestone_dealId_sortOrder_idx" ON "DealMilestone"("dealId", "sortOrder");

-- CreateIndex
CREATE INDEX "DealPayment_orgId_direction_settledAt_idx" ON "DealPayment"("orgId", "direction", "settledAt");

-- CreateIndex
CREATE INDEX "DealPayment_dealId_createdAt_idx" ON "DealPayment"("dealId", "createdAt");

-- CreateIndex
CREATE INDEX "DealEvent_orgId_occurredAt_idx" ON "DealEvent"("orgId", "occurredAt");

-- CreateIndex
CREATE INDEX "DealEvent_routeId_occurredAt_idx" ON "DealEvent"("routeId", "occurredAt");

-- CreateIndex
CREATE INDEX "DealEvent_subjectType_subjectId_idx" ON "DealEvent"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "Approval_routeQuoteId_status_idx" ON "Approval"("routeQuoteId", "status");

-- CreateIndex
CREATE INDEX "Task_routeId_status_idx" ON "Task"("routeId", "status");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "RouteHypothesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "RouteHypothesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_routeQuoteId_fkey" FOREIGN KEY ("routeQuoteId") REFERENCES "RouteQuote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerRequirement" ADD CONSTRAINT "BuyerRequirement_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerRequirement" ADD CONSTRAINT "BuyerRequirement_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "RouteHypothesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerRequirement" ADD CONSTRAINT "BuyerRequirement_sourceAttemptId_fkey" FOREIGN KEY ("sourceAttemptId") REFERENCES "OutreachAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerRequirement" ADD CONSTRAINT "BuyerRequirement_capturedById_fkey" FOREIGN KEY ("capturedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerRequirement" ADD CONSTRAINT "BuyerRequirement_decisionMakerContactId_fkey" FOREIGN KEY ("decisionMakerContactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerRequirement" ADD CONSTRAINT "BuyerRequirement_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "BuyerRequirement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCandidate" ADD CONSTRAINT "ProviderCandidate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCandidate" ADD CONSTRAINT "ProviderCandidate_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "RouteHypothesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCandidate" ADD CONSTRAINT "ProviderCandidate_providerCompanyId_fkey" FOREIGN KEY ("providerCompanyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteQuote" ADD CONSTRAINT "RouteQuote_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteQuote" ADD CONSTRAINT "RouteQuote_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "RouteHypothesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteQuote" ADD CONSTRAINT "RouteQuote_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "BuyerRequirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteQuote" ADD CONSTRAINT "RouteQuote_providerCandidateId_fkey" FOREIGN KEY ("providerCandidateId") REFERENCES "ProviderCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteQuote" ADD CONSTRAINT "RouteQuote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteQuote" ADD CONSTRAINT "RouteQuote_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "RouteQuote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteDeal" ADD CONSTRAINT "RouteDeal_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteDeal" ADD CONSTRAINT "RouteDeal_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "RouteHypothesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteDeal" ADD CONSTRAINT "RouteDeal_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "RouteQuote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteDeal" ADD CONSTRAINT "RouteDeal_buyerContactId_fkey" FOREIGN KEY ("buyerContactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteDeal" ADD CONSTRAINT "RouteDeal_providerCandidateId_fkey" FOREIGN KEY ("providerCandidateId") REFERENCES "ProviderCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteDeal" ADD CONSTRAINT "RouteDeal_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealMilestone" ADD CONSTRAINT "DealMilestone_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "RouteDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealPayment" ADD CONSTRAINT "DealPayment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealPayment" ADD CONSTRAINT "DealPayment_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "RouteDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealPayment" ADD CONSTRAINT "DealPayment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealEvent" ADD CONSTRAINT "DealEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealEvent" ADD CONSTRAINT "DealEvent_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "RouteHypothesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Invariants Prisma cannot express
-- ---------------------------------------------------------------------------

-- At most one live requirement per route. Two "current" requirements means two
-- answers to "what did the buyer ask for", and every quote priced afterwards
-- inherits the ambiguity.
CREATE UNIQUE INDEX "BuyerRequirement_one_current_per_route_key"
  ON "BuyerRequirement" ("routeId")
  WHERE "state" = 'CURRENT';

-- At most one selected provider per route, and at most one committed provider.
-- Selection is a decision; two selections is an unmade decision that looks made.
CREATE UNIQUE INDEX "ProviderCandidate_one_selected_per_route_key"
  ON "ProviderCandidate" ("routeId")
  WHERE "state" = 'SELECTED';

CREATE UNIQUE INDEX "ProviderCandidate_one_committed_per_route_key"
  ON "ProviderCandidate" ("routeId")
  WHERE "state" = 'COMMITTED';

-- At most one quote per route that is still working its way toward the buyer.
-- Terminal states are excluded so history accumulates freely; what cannot
-- happen is two different prices being live for the same route at once.
CREATE UNIQUE INDEX "RouteQuote_one_live_per_route_key"
  ON "RouteQuote" ("routeId")
  WHERE "state" IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT');

-- Direction and kind carry the sign. A negative amount would let the same
-- refund be recorded two ways and reconcile differently each time.
ALTER TABLE "DealPayment"
  ADD CONSTRAINT "DealPayment_amount_positive" CHECK ("amount" > 0);
