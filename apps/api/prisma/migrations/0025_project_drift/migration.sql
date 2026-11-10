-- Drift: whether what is running still matches the code on a project's
-- default branch, read from the daily `infra drift` check run (services/drift.ts).
-- All null until the first read.
ALTER TABLE "TfProject" ADD COLUMN "driftState" TEXT;
ALTER TABLE "TfProject" ADD COLUMN "driftMessage" TEXT;
ALTER TABLE "TfProject" ADD COLUMN "driftCheckUrl" TEXT;
ALTER TABLE "TfProject" ADD COLUMN "driftRanAt" TIMESTAMP(3);
ALTER TABLE "TfProject" ADD COLUMN "driftCheckedAt" TIMESTAMP(3);
