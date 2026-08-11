-- Lead tiers.
--
-- A second axis on PathHypothesis, orthogonal to LeadStage. Stage records how
-- far we have worked a hypothesis; tier records how much the world has done to
-- create the need. Both are required: a record can be advanced through stages
-- indefinitely without ever acquiring a reason to buy, which is exactly the
-- failure the board was showing.
--
-- Every existing row defaults to DIRECTORY_PROSPECT. That is the honest
-- starting point: the sources currently enabled establish that organisations
-- exist, and nothing more. Rows earn a better tier only by carrying dated
-- demand evidence.

CREATE TYPE "LeadTier" AS ENUM (
  'ACTIVE_DEMAND',
  'STRONG_TRIGGER',
  'PREDICTED_NEED',
  'DIRECTORY_PROSPECT',
  'REJECTED'
);

ALTER TABLE "PathHypothesis"
  ADD COLUMN "tier" "LeadTier" NOT NULL DEFAULT 'DIRECTORY_PROSPECT',
  ADD COLUMN "tierReason" TEXT,
  ADD COLUMN "rejectionFlags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "buyingWindow" TEXT;

-- Ranking within a tier is the access pattern: the attention queue asks for
-- the best Tier A rows, never for the best rows overall.
CREATE INDEX "PathHypothesis_orgId_tier_priorityScore_idx"
  ON "PathHypothesis"("orgId", "tier", "priorityScore");
