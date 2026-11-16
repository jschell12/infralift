-- Version lag (ADR 0012, phase 1). A project stores what its repository's
-- root module pins, as read by services/versions.ts: the providers in its
-- .terraform.lock.hcl, its required_providers constraints and its
-- required_version, or why the read failed. The comparison with the version
-- baseline happens when the fleet view is read, not here, so a pin moved in
-- lib/tf/baseline.ts reclassifies every project without a single re-read.
--
-- Add-column only. Existing rows stay null: never read. The sweep reads
-- never-read projects first, so they fill in over the first few ticks.
--
-- Reverse, if this has to be undone:
--   DROP INDEX "TfProject_versionCheckedAt_idx";
--   ALTER TABLE "TfProject" DROP COLUMN "versionCheckedAt";
--   ALTER TABLE "TfProject" DROP COLUMN "versionFacts";
ALTER TABLE "TfProject" ADD COLUMN "versionFacts" JSONB;
ALTER TABLE "TfProject" ADD COLUMN "versionCheckedAt" TIMESTAMP(3);

-- The sweep picks the oldest reads first.
CREATE INDEX "TfProject_versionCheckedAt_idx" ON "TfProject"("versionCheckedAt");
