-- Settling a disagreement supersedes both sides at once.
--
-- The claim table modelled supersession as one-to-one, which is right for the
-- ordinary case — a newer reading replaces the older one — and wrong for the
-- case the table was built for. When somebody rings back and establishes which
-- of two disputed answers holds, that single confirmed claim has to supersede
-- both of them, and a unique index on the pointer made the second update fail
-- inside the transaction. The Postgres audit caught it; nothing had shipped.
--
-- An ordinary index replaces it, so looking up what a claim superseded is still
-- a lookup rather than a scan.

-- DropIndex
DROP INDEX "Claim_supersededById_key";


CREATE INDEX "Claim_supersededById_idx" ON "Claim"("supersededById");
