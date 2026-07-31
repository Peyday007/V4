-- CreateEnum
CREATE TYPE "MessageOutcome" AS ENUM ('AWAITING_RESPONSE', 'REPLIED_POSITIVE', 'REPLIED_NEGATIVE', 'REPLIED_NEUTRAL', 'NO_RESPONSE', 'OPTED_OUT', 'UNDELIVERABLE');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "consentToSms" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasMobile" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "companyId" TEXT,
ADD COLUMN     "costCents" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "inboundBody" TEXT,
ADD COLUMN     "outcome" "MessageOutcome",
ADD COLUMN     "purpose" "CallType",
ADD COLUMN     "repliedAt" TIMESTAMP(3),
ADD COLUMN     "responseTimeSec" INTEGER,
ADD COLUMN     "segments" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "senderId" TEXT;

-- CreateIndex
CREATE INDEX "Message_orgId_channel_purpose_idx" ON "Message"("orgId", "channel", "purpose");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

