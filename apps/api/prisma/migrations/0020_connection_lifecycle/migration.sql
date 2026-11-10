-- A connection that stopped working used to say only "invalid", with no
-- reason and no warning before it expired. lastError holds the reason (set by
-- a failed verify or by a 401/403 during an assessment or git job), expiresAt
-- what the provider reported on the verify call, and updatedAt when either
-- last changed. Existing rows keep their status; updatedAt starts at now.
ALTER TABLE "ProviderConnection" ADD COLUMN "lastError" TEXT;
ALTER TABLE "ProviderConnection" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "ProviderConnection" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
