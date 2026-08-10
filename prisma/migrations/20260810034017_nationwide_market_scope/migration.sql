-- CreateEnum
CREATE TYPE "MarketScope" AS ENUM ('NATIONAL', 'STATE', 'METRO', 'COUNTY', 'CITY', 'POSTAL', 'RADIUS');

-- AlterTable
ALTER TABLE "Market" ADD COLUMN     "scope" "MarketScope" NOT NULL DEFAULT 'METRO',
ADD COLUMN     "states" TEXT[] DEFAULT ARRAY[]::TEXT[];
