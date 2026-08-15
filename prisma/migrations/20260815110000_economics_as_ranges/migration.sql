-- Modelled money becomes a range.
--
-- A playbook says this kind of work sells between eight hundred and four and a
-- half thousand dollars. The pipeline took the midpoint, rounded it, and stored
-- $2,650 — four significant figures out of a band spanning five times itself.
-- Every reader downstream treated that as an estimate of the deal in front of
-- them rather than as the middle of a category, and the precision did the
-- persuading.
--
-- The existing columns stay and become the midpoint, used for ranking only:
-- ordering a board needs one number per row and a range cannot supply one. No
-- surface shows them on their own. Existing rows keep their midpoint and carry
-- null bounds, which reads on screen as "modelled, and we no longer know how
-- wide" rather than as a confident figure.

-- AlterTable
ALTER TABLE "RouteHypothesis" ADD COLUMN     "economicsInputs" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "estimatedBuyerPriceHigh" DECIMAL(14,2),
ADD COLUMN     "estimatedBuyerPriceLow" DECIMAL(14,2),
ADD COLUMN     "estimatedGrossProfitHigh" DECIMAL(14,2),
ADD COLUMN     "estimatedGrossProfitLow" DECIMAL(14,2),
ADD COLUMN     "estimatedProviderCostHigh" DECIMAL(14,2),
ADD COLUMN     "estimatedProviderCostLow" DECIMAL(14,2);

