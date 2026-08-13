-- CreateEnum
CREATE TYPE "DataMode" AS ENUM ('PRODUCTION', 'TEST');

-- AlterTable
ALTER TABLE "CallerProfile" ADD COLUMN     "dataMode" "DataMode" NOT NULL DEFAULT 'PRODUCTION',
ADD COLUMN     "label" TEXT,
ADD COLUMN     "pinIssuedById" TEXT;

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "dataMode" "DataMode" NOT NULL DEFAULT 'PRODUCTION';

-- AlterTable
ALTER TABLE "DemandEvent" ADD COLUMN     "dataMode" "DataMode" NOT NULL DEFAULT 'PRODUCTION';

-- AlterTable
ALTER TABLE "OutreachAttempt" ADD COLUMN     "dataMode" "DataMode" NOT NULL DEFAULT 'PRODUCTION';

-- AlterTable
ALTER TABLE "PacketItem" ADD COLUMN     "dataMode" "DataMode" NOT NULL DEFAULT 'PRODUCTION';

-- AlterTable
ALTER TABLE "RouteHypothesis" ADD COLUMN     "dataMode" "DataMode" NOT NULL DEFAULT 'PRODUCTION';

-- AlterTable
ALTER TABLE "WorkPacket" ADD COLUMN     "dataMode" "DataMode" NOT NULL DEFAULT 'PRODUCTION';

-- CreateIndex
CREATE INDEX "CallerProfile_dataMode_idx" ON "CallerProfile"("dataMode");

-- AddForeignKey
ALTER TABLE "CallerProfile" ADD CONSTRAINT "CallerProfile_pinIssuedById_fkey" FOREIGN KEY ("pinIssuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Production and sandbox cannot mix.
--
-- Enforced here rather than in the queries, because there are five surfaces
-- that select work — the demand board, the callers page, the assignment
-- preview, the packet builder and the workspace's own serve loop — and a rule
-- that must be remembered in five places is a rule that will be forgotten in
-- one. The cost of forgetting is a real business rung by somebody practising,
-- or a caller's shift spent on invented companies.
-- ---------------------------------------------------------------------------

-- A route belongs to the same world as the company and the event behind it.
CREATE OR REPLACE FUNCTION "routeDataModeGuard"() RETURNS trigger AS $$
DECLARE
  company_mode "DataMode";
  event_mode "DataMode";
BEGIN
  SELECT "dataMode" INTO company_mode FROM "Company" WHERE "id" = NEW."companyId";
  SELECT "dataMode" INTO event_mode FROM "DemandEvent" WHERE "id" = NEW."eventId";

  IF company_mode IS NOT NULL AND company_mode <> NEW."dataMode" THEN
    RAISE EXCEPTION 'route_data_mode: a % route cannot be about a % company',
      NEW."dataMode", company_mode;
  END IF;
  IF event_mode IS NOT NULL AND event_mode <> NEW."dataMode" THEN
    RAISE EXCEPTION 'route_data_mode: a % route cannot come from a % event',
      NEW."dataMode", event_mode;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RouteHypothesis_matches_its_company_and_event"
  BEFORE INSERT OR UPDATE ON "RouteHypothesis"
  FOR EACH ROW EXECUTE FUNCTION "routeDataModeGuard"();

-- A packet belongs to the same world as the caller holding it.
CREATE OR REPLACE FUNCTION "packetDataModeGuard"() RETURNS trigger AS $$
DECLARE
  caller_mode "DataMode";
BEGIN
  SELECT cp."dataMode" INTO caller_mode
  FROM "CallerProfile" cp WHERE cp."userId" = NEW."callerId";

  -- No profile means the person is not a caller at all. Left to the
  -- application to refuse with a sentence; this trigger only polices mixing.
  IF caller_mode IS NOT NULL AND caller_mode <> NEW."dataMode" THEN
    RAISE EXCEPTION 'packet_data_mode: a % packet cannot be handed to a % caller',
      NEW."dataMode", caller_mode;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "WorkPacket_matches_its_caller"
  BEFORE INSERT OR UPDATE ON "WorkPacket"
  FOR EACH ROW EXECUTE FUNCTION "packetDataModeGuard"();

-- The load-bearing one: an item joins a caller to a route, and is the only
-- place the two worlds could ever touch.
CREATE OR REPLACE FUNCTION "packetItemDataModeGuard"() RETURNS trigger AS $$
DECLARE
  caller_mode "DataMode";
  route_mode "DataMode";
BEGIN
  SELECT cp."dataMode" INTO caller_mode
  FROM "CallerProfile" cp WHERE cp."userId" = NEW."callerId";
  SELECT r."dataMode" INTO route_mode
  FROM "RouteHypothesis" r WHERE r."id" = NEW."routeId";

  IF route_mode IS NOT NULL AND route_mode <> NEW."dataMode" THEN
    RAISE EXCEPTION 'packet_item_data_mode: a % item cannot point at a % opportunity',
      NEW."dataMode", route_mode;
  END IF;
  IF caller_mode IS NOT NULL AND caller_mode <> NEW."dataMode" THEN
    RAISE EXCEPTION 'packet_item_data_mode: a % item cannot be assigned to a % caller',
      NEW."dataMode", caller_mode;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PacketItem_never_crosses_production_and_test"
  BEFORE INSERT OR UPDATE ON "PacketItem"
  FOR EACH ROW EXECUTE FUNCTION "packetItemDataModeGuard"();

-- An attempt inherits its route's world, so measurement can exclude sandbox
-- work with a column rather than a join it might forget.
CREATE OR REPLACE FUNCTION "attemptDataModeGuard"() RETURNS trigger AS $$
DECLARE
  route_mode "DataMode";
BEGIN
  SELECT r."dataMode" INTO route_mode
  FROM "RouteHypothesis" r WHERE r."id" = NEW."routeId";

  IF route_mode IS NOT NULL AND route_mode <> NEW."dataMode" THEN
    RAISE EXCEPTION 'attempt_data_mode: a % attempt cannot be recorded against a % opportunity',
      NEW."dataMode", route_mode;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OutreachAttempt_matches_its_opportunity"
  BEFORE INSERT OR UPDATE ON "OutreachAttempt"
  FOR EACH ROW EXECUTE FUNCTION "attemptDataModeGuard"();

-- Indexes for the mode-scoped queries every eligibility surface now runs.
CREATE INDEX "RouteHypothesis_dataMode_idx" ON "RouteHypothesis" ("orgId", "dataMode", "status");
CREATE INDEX "OutreachAttempt_dataMode_idx" ON "OutreachAttempt" ("orgId", "dataMode", "occurredAt");
CREATE INDEX "PacketItem_dataMode_idx" ON "PacketItem" ("orgId", "dataMode", "status");
