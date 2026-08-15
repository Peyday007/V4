-- CreateEnum
CREATE TYPE "ClaimStanding" AS ENUM ('CONFIRMED', 'INFERRED', 'UNKNOWN', 'CONTRADICTED');

-- CreateEnum
CREATE TYPE "ClaimSourceKind" AS ENUM ('PERSON', 'PUBLISHED_RECORD', 'CALCULATION', 'ENGINE_INFERENCE', 'OPERATOR', 'ABSENCE');

-- CreateEnum
CREATE TYPE "ClaimAbout" AS ENUM ('DEMAND', 'BUYER', 'PROVIDER', 'ECONOMICS', 'TIMING', 'COMPLIANCE', 'STRUCTURE', 'CONTACT');

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dataMode" "DataMode" NOT NULL DEFAULT 'PRODUCTION',
    "routeId" TEXT NOT NULL,
    "about" "ClaimAbout" NOT NULL,
    "key" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "value" JSONB,
    "standing" "ClaimStanding" NOT NULL,
    "sourceKind" "ClaimSourceKind" NOT NULL,
    "sourceLabel" TEXT NOT NULL,
    "sourceRef" TEXT,
    "observedAt" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confidence" DOUBLE PRECISION,
    "correctiveAction" TEXT,
    "supersededAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "contradictsId" TEXT,
    "companyId" TEXT,
    "contactId" TEXT,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Claim_supersededById_key" ON "Claim"("supersededById");

-- CreateIndex
CREATE INDEX "Claim_orgId_routeId_key_idx" ON "Claim"("orgId", "routeId", "key");

-- CreateIndex
CREATE INDEX "Claim_routeId_supersededAt_idx" ON "Claim"("routeId", "supersededAt");

-- CreateIndex
CREATE INDEX "Claim_orgId_dataMode_standing_idx" ON "Claim"("orgId", "dataMode", "standing");

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "Claim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_contradictsId_fkey" FOREIGN KEY ("contradictsId") REFERENCES "Claim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "RouteHypothesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Isolation: a claim belongs to its route's world.
-- ---------------------------------------------------------------------------
--
-- Same rule as requirements, candidates, quotes, deals, payments and attempts:
-- on insert the route decides, and on update a disagreement is refused. A
-- practice call must never be able to put a claim on a production deal, and no
-- writer should have to remember that.
CREATE OR REPLACE FUNCTION "claimDataModeGuard"() RETURNS trigger AS $$
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
    RAISE EXCEPTION 'claim_data_mode: a % claim cannot belong to a % opportunity',
      NEW."dataMode", route_mode;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "claim_data_mode" ON "Claim";
CREATE TRIGGER "claim_data_mode"
  BEFORE INSERT OR UPDATE ON "Claim"
  FOR EACH ROW EXECUTE FUNCTION "claimDataModeGuard"();

-- ---------------------------------------------------------------------------
-- The shape of an honest claim, enforced where it cannot be forgotten.
-- ---------------------------------------------------------------------------
--
-- Three rules the writer applies and the database also applies, because the
-- writer is one code path today and will be four by the time anybody notices.

-- A confidence figure on anything but an inference is noise at best. On a
-- confirmed fact it invites doubt where there is none; on an unknown it is a
-- contradiction in terms.
ALTER TABLE "Claim" ADD CONSTRAINT "claim_confidence_only_when_inferred"
  CHECK (("standing" = 'INFERRED') OR ("confidence" IS NULL));

-- A confidence outside nought-to-one is a bug that would render as a
-- percentage.
ALTER TABLE "Claim" ADD CONSTRAINT "claim_confidence_range"
  CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));

-- Anything not confirmed has to say what would settle it. A claim nobody can
-- act on stays where it is forever, and a ledger full of those is a list of
-- reasons not to trust the product rather than a work queue.
ALTER TABLE "Claim" ADD CONSTRAINT "claim_unsettled_needs_action"
  CHECK (("standing" = 'CONFIRMED') OR ("correctiveAction" IS NOT NULL AND length("correctiveAction") > 0));

-- A contradiction has to name what it contradicts, or it is just an opinion
-- with a dramatic label.
ALTER TABLE "Claim" ADD CONSTRAINT "claim_contradiction_names_its_target"
  CHECK (("standing" <> 'CONTRADICTED') OR ("contradictsId" IS NOT NULL));
