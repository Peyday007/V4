-- Caller sign-in by PIN alone.
--
-- Two things have to exist for a PIN with no email beside it to identify
-- somebody. First a deterministic index, because a hash cannot be looked up
-- and verifying against every profile in turn is a slow scan and a timing
-- oracle; `pinLookup` holds a keyed HMAC, which finds the caller in one query
-- and is worth nothing to a reader of the table who does not have the key.
-- Second, uniqueness: a PIN two people share identifies neither, and every
-- attribution downstream would be a coin toss.
ALTER TABLE "CallerProfile" ADD COLUMN "pinLookup" TEXT;
CREATE UNIQUE INDEX "CallerProfile_pinLookup_key" ON "CallerProfile"("pinLookup");

-- Dropping the identifier also changes the shape of an attack on this door. A
-- per-caller lockout stops somebody guessing at one person and cannot see
-- somebody trying PIN after PIN against nobody in particular, because every
-- guess lands on whoever holds it and no single profile accumulates a failure.
-- These attempts are counted per source and in total, durably, because the
-- in-process limiter is per-instance and serverless has as many instances as
-- it likes.
CREATE TABLE "PinAttempt" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "windowAt" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PinAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PinAttempt_scope_windowAt_key" ON "PinAttempt"("scope", "windowAt");
CREATE INDEX "PinAttempt_windowAt_idx" ON "PinAttempt"("windowAt");
