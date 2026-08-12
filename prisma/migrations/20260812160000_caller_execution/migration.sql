-- CreateEnum
CREATE TYPE "PacketStatus" AS ENUM ('OPEN', 'COMPLETE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PacketItemStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'WORKED', 'SKIPPED', 'RETURNED');

-- CreateEnum
CREATE TYPE "IncidentKind" AS ENUM ('SAVE_FAILURE', 'ASSIGNMENT_CONFLICT', 'STALE_ASSIGNMENT', 'ELIGIBILITY_CHANGED', 'INTEGRATION_FAILURE');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'RESOLVED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CallDisposition" ADD VALUE 'REACHED_RELEVANT_PERSON';
ALTER TYPE "CallDisposition" ADD VALUE 'DECISION_MAKER_IDENTIFIED';
ALTER TYPE "CallDisposition" ADD VALUE 'NEED_CONFIRMED';
ALTER TYPE "CallDisposition" ADD VALUE 'NEED_UNCONFIRMED';
ALTER TYPE "CallDisposition" ADD VALUE 'QUOTE_REQUESTED';

-- AlterTable
ALTER TABLE "CallerProfile" ADD COLUMN     "pinFailedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pinHash" TEXT,
ADD COLUMN     "pinLastUsedAt" TIMESTAMP(3),
ADD COLUMN     "pinLockedUntil" TIMESTAMP(3),
ADD COLUMN     "pinRevokedAt" TIMESTAMP(3),
ADD COLUMN     "pinSetAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OutreachAttempt" ADD COLUMN     "discovery" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "WorkPacket" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "callerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "PacketStatus" NOT NULL DEFAULT 'OPEN',
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "scriptVersion" TEXT,
    "processVersion" TEXT,
    "offerVersion" TEXT,
    "discoveryObjective" TEXT,
    "experimentCohort" TEXT,
    "completionTarget" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkPacket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PacketItem" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "packetId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "status" "PacketItemStatus" NOT NULL DEFAULT 'PENDING',
    "position" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "workedAt" TIMESTAMP(3),
    "skippedReason" TEXT,
    "returnedReason" TEXT,
    "reassignedFromPacketId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PacketItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkIncident" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "callerId" TEXT,
    "routeId" TEXT,
    "kind" "IncidentKind" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "detail" TEXT NOT NULL,
    "preserved" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolution" TEXT,

    CONSTRAINT "WorkIncident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkPacket_orgId_callerId_status_idx" ON "WorkPacket"("orgId", "callerId", "status");

-- CreateIndex
CREATE INDEX "WorkPacket_orgId_status_expiresAt_idx" ON "WorkPacket"("orgId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "PacketItem_orgId_status_idx" ON "PacketItem"("orgId", "status");

-- CreateIndex
CREATE INDEX "PacketItem_routeId_status_idx" ON "PacketItem"("routeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PacketItem_packetId_routeId_key" ON "PacketItem"("packetId", "routeId");

-- CreateIndex
CREATE INDEX "WorkIncident_orgId_status_createdAt_idx" ON "WorkIncident"("orgId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "WorkIncident_orgId_callerId_status_idx" ON "WorkIncident"("orgId", "callerId", "status");

-- AddForeignKey
ALTER TABLE "WorkPacket" ADD CONSTRAINT "WorkPacket_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkPacket" ADD CONSTRAINT "WorkPacket_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PacketItem" ADD CONSTRAINT "PacketItem_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PacketItem" ADD CONSTRAINT "PacketItem_packetId_fkey" FOREIGN KEY ("packetId") REFERENCES "WorkPacket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PacketItem" ADD CONSTRAINT "PacketItem_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "RouteHypothesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkIncident" ADD CONSTRAINT "WorkIncident_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkIncident" ADD CONSTRAINT "WorkIncident_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkIncident" ADD CONSTRAINT "WorkIncident_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "RouteHypothesis"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A route may be actively owned by exactly one packet at a time.
--
-- Written by hand because Prisma cannot express a partial unique index, and
-- expressing it any other way would make it a convention rather than an
-- invariant. Two callers each being told an organisation is theirs is the
-- failure this prevents, and application-level checks lose that race.
--
-- WORKED, SKIPPED and RETURNED items are deliberately outside the index: the
-- history of who worked what is kept, and only live ownership is exclusive.
CREATE UNIQUE INDEX "PacketItem_active_owner_key"
  ON "PacketItem" ("routeId")
  WHERE "status" IN ('PENDING', 'IN_PROGRESS');
