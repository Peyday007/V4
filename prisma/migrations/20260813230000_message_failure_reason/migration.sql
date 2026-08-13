-- Why a message did not go.
--
-- Outbound mail had a status and an outcome and nowhere to say what happened.
-- With no transport configured the send path wrote SENT anyway, so the failure
-- was invisible twice over: the row claimed delivery, and there was no field
-- in which to contradict it. An operator's first question about a message that
-- never arrived is "why", and the answer belongs on the record rather than in
-- a log line on a server nobody reads.
ALTER TABLE "Message" ADD COLUMN "failureReason" TEXT;
