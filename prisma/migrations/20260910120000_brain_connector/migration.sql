-- The Brain connector: two additive tables and nothing else.
--
-- No existing table is altered, no column is dropped and no row is touched,
-- so applying this to a database holding real work changes nothing that was
-- already there. Rolling it back is dropping these two tables; the
-- opportunities they point at are untouched by either direction.

-- CreateTable
CREATE TABLE "BrainLink" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "brainId" TEXT NOT NULL,
    "brainProjectId" TEXT NOT NULL,
    "lastPushedVersion" TIMESTAMP(3),
    "lastPushedHash" TEXT,
    "lastPushedAt" TIMESTAMP(3),
    "state" TEXT,
    "stateReason" TEXT,
    "priority" TEXT,
    "priorityRank" INTEGER,
    "reason" TEXT,
    "confidence" INTEGER,
    "missionId" TEXT,
    "documentId" TEXT,
    "conclusion" TEXT,
    "filedUnder" TEXT,
    "nextAction" TEXT,
    "brainUpdatedAt" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "commandedAt" TIMESTAMP(3),
    "commandedById" TEXT,
    "commandedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrainLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrainSyncState" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "pushCursor" TIMESTAMP(3),
    "pushedAt" TIMESTAMP(3),
    "pullCursor" TEXT,
    "pulledAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrainSyncState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrainLink_opportunityId_key" ON "BrainLink"("opportunityId");

-- CreateIndex
CREATE INDEX "BrainLink_orgId_state_idx" ON "BrainLink"("orgId", "state");

-- CreateIndex
CREATE INDEX "BrainLink_orgId_brainUpdatedAt_idx" ON "BrainLink"("orgId", "brainUpdatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BrainLink_orgId_brainId_key" ON "BrainLink"("orgId", "brainId");

-- CreateIndex
CREATE UNIQUE INDEX "BrainSyncState_orgId_key" ON "BrainSyncState"("orgId");

-- AddForeignKey
ALTER TABLE "BrainLink" ADD CONSTRAINT "BrainLink_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainLink" ADD CONSTRAINT "BrainLink_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainSyncState" ADD CONSTRAINT "BrainSyncState_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

