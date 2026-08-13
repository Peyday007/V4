-- Practice must not count as performance.
--
-- The sandbox was isolated everywhere it was looked for — routes, companies,
-- events, packets, items, attempts — and then a saved practice call fell
-- straight through into `DemandOutcome`, because the funnel writes a milestone
-- for every disposition and that table had no world of its own. Sixteen rows
-- from one walkthrough were sitting in the same numbers the source scorecards,
-- the funnel report and the experiment readouts are computed from, which means
-- an owner practising for ten minutes moved the measurements the business is
-- steered by.
--
-- The column is the fix; the trigger is what stops it coming back. A milestone
-- now belongs to the same world as the route that earned it, and Postgres will
-- not accept a row that claims otherwise.

-- AlterTable
ALTER TABLE "DemandOutcome" ADD COLUMN "dataMode" "DataMode" NOT NULL DEFAULT 'PRODUCTION';

-- Backfill from the route each milestone belongs to. Rows whose route is gone
-- keep the production default: they are historical attribution for a record
-- that once existed, and reclassifying them as practice would silently delete
-- them from every report.
UPDATE "DemandOutcome" o
SET "dataMode" = r."dataMode"
FROM "RouteHypothesis" r
WHERE r."id" = o."routeId";

-- The rows the sandbox already wrote. Their routes are deleted on every reset,
-- so the join above cannot reach them, but the connector name is unambiguous: only
-- the sandbox fixtures use it.
UPDATE "DemandOutcome" SET "dataMode" = 'TEST' WHERE "connector" = 'sandbox';

-- CreateIndex
CREATE INDEX "DemandOutcome_orgId_dataMode_stage_idx" ON "DemandOutcome"("orgId", "dataMode", "stage");

-- A milestone belongs to the world of the route that earned it.
CREATE OR REPLACE FUNCTION "outcomeDataModeGuard"() RETURNS trigger AS $$
DECLARE
  route_mode "DataMode";
BEGIN
  IF NEW."routeId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "dataMode" INTO route_mode FROM "RouteHypothesis" WHERE "id" = NEW."routeId";

  IF route_mode IS NOT NULL AND route_mode <> NEW."dataMode" THEN
    RAISE EXCEPTION 'outcome_data_mode: a % milestone cannot be earned by a % opportunity',
      NEW."dataMode", route_mode;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DemandOutcome_never_measures_practice_as_production"
  BEFORE INSERT OR UPDATE ON "DemandOutcome"
  FOR EACH ROW EXECUTE FUNCTION "outcomeDataModeGuard"();
