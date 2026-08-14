-- Let the route decide an attempt's world, rather than requiring every writer
-- to know it.
--
-- The guard compared the attempt's data mode with its route's and refused a
-- mismatch. Correct, and it put the burden in the wrong place: every path that
-- records an attempt — the caller save, three audit scripts, the workspace —
-- had to remember to pass the mode, and each one that forgot got a refusal
-- naming a column it had never heard of rather than doing the obvious thing.
--
-- This is the same correction already made for requirements, candidates,
-- quotes, deals and payments: on insert the route decides, and on update a
-- disagreement is still refused. Converging on one rule rather than keeping two
-- shapes of the same guard.
CREATE OR REPLACE FUNCTION "attemptDataModeGuard"() RETURNS trigger AS $$
DECLARE
  route_mode "DataMode";
BEGIN
  SELECT "dataMode" INTO route_mode FROM "RouteHypothesis" WHERE "id" = NEW."routeId";

  IF route_mode IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW."dataMode" := route_mode;
  ELSIF NEW."dataMode" <> route_mode THEN
    RAISE EXCEPTION 'attempt_data_mode: a % attempt cannot belong to a % opportunity',
      NEW."dataMode", route_mode;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
