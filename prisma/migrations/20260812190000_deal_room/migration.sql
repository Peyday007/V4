-- Deal rooms and engagement.
--
-- Additive only. Nothing here alters or drops an existing column.
--
-- Two things at the end are hand-written. A partial unique index gives each
-- route at most one live room, because two live links for the same prospect is
-- two different stories arriving in the same inbox. And a check constraint
-- requires the token to be long enough to be worth calling a secret — the
-- application generates 32 random bytes, and the database refuses anything a
-- careless migration or a fixture might substitute for one.

-- CreateEnum
CREATE TYPE "RoomState" AS ENUM ('DRAFT', 'SENT', 'DELIVERED', 'OPENED', 'RESPONDED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RoomEventKind" AS ENUM ('CREATED', 'SENT', 'DELIVERED', 'OPENED', 'RESPONDED', 'INFORMATION_SUPPLIED', 'NEXT_STEP_REQUESTED', 'QUOTE_REQUESTED', 'PROOF_STEP_REQUESTED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ProofStepKind" AS ENUM ('SAMPLE_ORDER', 'SMALL_INITIAL_SHIPMENT', 'SINGLE_LOCATION_PILOT', 'ONE_TIME_SERVICE', 'SITE_WALKTHROUGH', 'PRELIMINARY_QUOTE', 'LIMITED_SCOPE_SUBCONTRACT', 'VENDOR_CAPABILITY_REVIEW', 'PAID_DIAGNOSTIC', 'NONE');

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "routeId" TEXT;

-- CreateTable
CREATE TABLE "DealRoom" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "state" "RoomState" NOT NULL DEFAULT 'DRAFT',
    "content" JSONB NOT NULL DEFAULT '{}',
    "requirementId" TEXT,
    "quoteId" TEXT,
    "proofStep" "ProofStepKind" NOT NULL DEFAULT 'NONE',
    "proofStepReason" TEXT,
    "contactId" TEXT,
    "channel" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "firstOpenAt" TIMESTAMP(3),
    "lastOpenAt" TIMESTAMP(3),
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "respondedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "responseNote" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealRoomEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "kind" "RoomEventKind" NOT NULL,
    "detail" TEXT,
    "userAgentClass" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealRoomEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DealRoom_token_key" ON "DealRoom"("token");

-- CreateIndex
CREATE INDEX "DealRoom_orgId_state_idx" ON "DealRoom"("orgId", "state");

-- CreateIndex
CREATE INDEX "DealRoom_routeId_createdAt_idx" ON "DealRoom"("routeId", "createdAt");

-- CreateIndex
CREATE INDEX "DealRoom_expiresAt_idx" ON "DealRoom"("expiresAt");

-- CreateIndex
CREATE INDEX "DealRoomEvent_orgId_occurredAt_idx" ON "DealRoomEvent"("orgId", "occurredAt");

-- CreateIndex
CREATE INDEX "DealRoomEvent_roomId_occurredAt_idx" ON "DealRoomEvent"("roomId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "DealRoomEvent_roomId_kind_dedupeKey_key" ON "DealRoomEvent"("roomId", "kind", "dedupeKey");

-- CreateIndex
CREATE INDEX "Message_routeId_createdAt_idx" ON "Message"("routeId", "createdAt");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "RouteHypothesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealRoom" ADD CONSTRAINT "DealRoom_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealRoom" ADD CONSTRAINT "DealRoom_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "RouteHypothesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealRoom" ADD CONSTRAINT "DealRoom_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "BuyerRequirement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealRoom" ADD CONSTRAINT "DealRoom_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "RouteQuote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealRoom" ADD CONSTRAINT "DealRoom_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealRoom" ADD CONSTRAINT "DealRoom_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealRoomEvent" ADD CONSTRAINT "DealRoomEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealRoomEvent" ADD CONSTRAINT "DealRoomEvent_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "DealRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Invariants Prisma cannot express
-- ---------------------------------------------------------------------------

-- One live room per route. Terminal states are excluded so history accumulates.
CREATE UNIQUE INDEX "DealRoom_one_live_per_route_key"
  ON "DealRoom" ("routeId")
  WHERE "state" IN ('DRAFT', 'SENT', 'DELIVERED', 'OPENED', 'RESPONDED');

-- The token is the only thing standing between this page and the open
-- internet. A short one is not a token, whatever generated it.
ALTER TABLE "DealRoom"
  ADD CONSTRAINT "DealRoom_token_long_enough" CHECK (length("token") >= 32);

-- A room with no expiry is a public page about a named company that stays up
-- forever. The application always sets one; this makes it impossible not to.
ALTER TABLE "DealRoom"
  ADD CONSTRAINT "DealRoom_expires_after_creation" CHECK ("expiresAt" > "createdAt");
