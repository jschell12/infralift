-- Connections are checked again automatically (services/connection-checks.ts),
-- and a connection's status is one of three words.
--
-- 1. Status. The code has only ever written unverified, valid or invalid, but
--    production had rows saying "connected", written by something outside the
--    API. The dashboard read that as "not valid" and told people to fix a
--    connection nothing was known to be wrong with. Such a row is unverified:
--    nothing has checked it. The daily check verifies it on its first sweep,
--    because it has never been checked (lastCheckedAt stays null below). The
--    CHECK constraint makes the next stray word fail at the write instead of
--    surfacing in the dashboard.
UPDATE "ProviderConnection"
SET "status" = 'unverified'
WHERE "status" NOT IN ('unverified', 'valid', 'invalid');

ALTER TABLE "ProviderConnection"
  ADD CONSTRAINT "ProviderConnection_status_check"
  CHECK ("status" IN ('unverified', 'valid', 'invalid'));

-- 2. When a connection was last checked (any outcome), and a claim so two
--    checks of one connection cannot run at once.
ALTER TABLE "ProviderConnection" ADD COLUMN "lastCheckedAt" TIMESTAMP(3);
ALTER TABLE "ProviderConnection" ADD COLUMN "verifyingSince" TIMESTAMP(3);

-- A connection that verified successfully was checked then. One that never
-- did keeps null, so the first sweep checks it.
UPDATE "ProviderConnection" SET "lastCheckedAt" = "lastVerifiedAt";

-- The sweep picks the oldest checks first.
CREATE INDEX "ProviderConnection_lastCheckedAt_idx" ON "ProviderConnection"("lastCheckedAt");
