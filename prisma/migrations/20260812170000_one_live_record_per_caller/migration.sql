-- One live record per caller, enforced by the database.
--
-- Two browser tabs each asking for "the next opportunity" claimed two
-- different records, so a caller held one they were working and one going cold
-- behind a thirty-minute lease. Serialising it in application code loses the
-- race; a partial unique index does not.
--
-- `callerId` is copied from the packet because a partial unique index needs the
-- column on the row it indexes. It is denormalised and it is the reason the
-- invariant can exist at all.

-- Added nullable and backfilled before it is made NOT NULL, so the migration is
-- safe against a table that already has rows.
ALTER TABLE "PacketItem" ADD COLUMN "callerId" TEXT;

UPDATE "PacketItem" pi
SET "callerId" = p."callerId"
FROM "WorkPacket" p
WHERE p."id" = pi."packetId" AND pi."callerId" IS NULL;

-- Anything still null has no packet to inherit from and cannot be owned by
-- anybody, so it is not a live record.
DELETE FROM "PacketItem" WHERE "callerId" IS NULL;

ALTER TABLE "PacketItem" ALTER COLUMN "callerId" SET NOT NULL;

-- The invariant: a caller may hold exactly one record at a time.
CREATE UNIQUE INDEX "PacketItem_one_live_per_caller_key"
  ON "PacketItem" ("callerId")
  WHERE "status" = 'IN_PROGRESS';

CREATE INDEX "PacketItem_callerId_status_idx" ON "PacketItem" ("callerId", "status");
