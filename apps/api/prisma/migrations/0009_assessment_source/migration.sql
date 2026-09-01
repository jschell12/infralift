-- Assessments can now come from a snapshot the customer collected themselves
-- (packages/collectors) instead of from a token we hold.
--
-- connectionId becomes nullable because a bundle-sourced assessment has no
-- ProviderConnection behind it: there is no token, which is the entire point.
-- `source` records which path produced the row, so a report can say whether
-- the numbers were observed through the provider API or self-reported.

ALTER TABLE "Assessment" ALTER COLUMN "connectionId" DROP NOT NULL;

ALTER TABLE "Assessment" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'api';

-- Provenance of a bundle: which collector wrote it and when it was run. Null
-- for api-sourced assessments. collectedAt is the customer's clock at
-- collection time, deliberately distinct from our createdAt, so a stale
-- snapshot uploaded weeks later is visible as stale.
ALTER TABLE "Assessment" ADD COLUMN "collectorVersion" TEXT;
ALTER TABLE "Assessment" ADD COLUMN "collectedAt" TIMESTAMP(3);
