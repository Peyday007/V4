-- The commercial tables did not know which world they were in.
--
-- Routes, companies, events, packets, attempts and funnel milestones all carry
-- a data mode. The tables the money lives in — requirements, provider
-- candidates, quotes, deals and payments — did not. So a sandbox opportunity
-- driven through the full lifecycle would have put its quotes into the chain
-- health report and its payments into the collected-revenue aggregate, and the
-- numbers an owner steers by would have moved because somebody practised.
--
-- The column is filled by a trigger rather than by the writers. There are five
-- tables, a dozen write paths and no realistic prospect of every future one
-- remembering; the route already knows the answer, so the database asks it.
-- The same trigger refuses an update that tries to disagree with the route,
-- which makes the invariant true rather than conventional.

ALTER TABLE "BuyerRequirement"  ADD COLUMN "dataMode" "DataMode" NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE "ProviderCandidate" ADD COLUMN "dataMode" "DataMode" NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE "RouteQuote"        ADD COLUMN "dataMode" "DataMode" NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE "RouteDeal"         ADD COLUMN "dataMode" "DataMode" NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE "DealPayment"       ADD COLUMN "dataMode" "DataMode" NOT NULL DEFAULT 'PRODUCTION';

-- Backfill from the route each row already belongs to.
UPDATE "BuyerRequirement" x SET "dataMode" = r."dataMode"
  FROM "RouteHypothesis" r WHERE r."id" = x."routeId";
UPDATE "ProviderCandidate" x SET "dataMode" = r."dataMode"
  FROM "RouteHypothesis" r WHERE r."id" = x."routeId";
UPDATE "RouteQuote" x SET "dataMode" = r."dataMode"
  FROM "RouteHypothesis" r WHERE r."id" = x."routeId";
UPDATE "RouteDeal" x SET "dataMode" = r."dataMode"
  FROM "RouteHypothesis" r WHERE r."id" = x."routeId";
UPDATE "DealPayment" p SET "dataMode" = r."dataMode"
  FROM "RouteDeal" d JOIN "RouteHypothesis" r ON r."id" = d."routeId"
  WHERE d."id" = p."dealId";

CREATE INDEX "BuyerRequirement_orgId_dataMode_idx"  ON "BuyerRequirement"("orgId", "dataMode");
CREATE INDEX "ProviderCandidate_orgId_dataMode_idx" ON "ProviderCandidate"("orgId", "dataMode");
CREATE INDEX "RouteQuote_orgId_dataMode_idx"        ON "RouteQuote"("orgId", "dataMode");
CREATE INDEX "RouteDeal_orgId_dataMode_idx"         ON "RouteDeal"("orgId", "dataMode");
CREATE INDEX "DealPayment_orgId_dataMode_idx"       ON "DealPayment"("orgId", "dataMode");

-- ---------------------------------------------------------------------------
-- The route decides.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "routeScopedDataModeGuard"() RETURNS trigger AS $$
DECLARE
  route_mode "DataMode";
BEGIN
  SELECT "dataMode" INTO route_mode FROM "RouteHypothesis" WHERE "id" = NEW."routeId";

  IF route_mode IS NULL THEN
    RETURN NEW;
  END IF;

  -- On insert the writer does not have to know; on update it may not disagree.
  IF TG_OP = 'INSERT' THEN
    NEW."dataMode" := route_mode;
  ELSIF NEW."dataMode" <> route_mode THEN
    RAISE EXCEPTION 'route_scoped_data_mode: a % row cannot belong to a % opportunity',
      NEW."dataMode", route_mode;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BuyerRequirement_belongs_to_its_routes_world"
  BEFORE INSERT OR UPDATE ON "BuyerRequirement"
  FOR EACH ROW EXECUTE FUNCTION "routeScopedDataModeGuard"();

CREATE TRIGGER "ProviderCandidate_belongs_to_its_routes_world"
  BEFORE INSERT OR UPDATE ON "ProviderCandidate"
  FOR EACH ROW EXECUTE FUNCTION "routeScopedDataModeGuard"();

CREATE TRIGGER "RouteQuote_belongs_to_its_routes_world"
  BEFORE INSERT OR UPDATE ON "RouteQuote"
  FOR EACH ROW EXECUTE FUNCTION "routeScopedDataModeGuard"();

CREATE TRIGGER "RouteDeal_belongs_to_its_routes_world"
  BEFORE INSERT OR UPDATE ON "RouteDeal"
  FOR EACH ROW EXECUTE FUNCTION "routeScopedDataModeGuard"();

-- Payments reach the route through the deal.
CREATE OR REPLACE FUNCTION "paymentDataModeGuard"() RETURNS trigger AS $$
DECLARE
  deal_mode "DataMode";
BEGIN
  SELECT r."dataMode" INTO deal_mode
  FROM "RouteDeal" d JOIN "RouteHypothesis" r ON r."id" = d."routeId"
  WHERE d."id" = NEW."dealId";

  IF deal_mode IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW."dataMode" := deal_mode;
  ELSIF NEW."dataMode" <> deal_mode THEN
    RAISE EXCEPTION 'payment_data_mode: a % payment cannot belong to a % deal',
      NEW."dataMode", deal_mode;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DealPayment_belongs_to_its_deals_world"
  BEFORE INSERT OR UPDATE ON "DealPayment"
  FOR EACH ROW EXECUTE FUNCTION "paymentDataModeGuard"();
