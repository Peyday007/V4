-- The competing commercial readings of an event, and which one won.
--
-- Nullable and defaulted to nothing, so every existing event is untouched and
-- fills in on its next pipeline pass. No backfill: a competition result
-- invented for a historical event would be a fabricated decision, and the
-- honest value for an event nothing has re-read is null.
ALTER TABLE "DemandEvent" ADD COLUMN "competition" JSONB;
