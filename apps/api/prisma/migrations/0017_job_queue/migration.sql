-- Job queue: a job is claimed by exactly one API process before it runs.
-- claimedBy names the process, so one that starts after a restart can tell
-- which unfinished jobs were left behind by a process that is gone.

-- AlterTable
ALTER TABLE "TfJob" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedBy" TEXT;

-- CreateIndex
CREATE INDEX "TfJob_status_claimedAt_idx" ON "TfJob"("status", "claimedAt");

-- Jobs left unfinished before the queue existed (crashed or restarted
-- processes) are claimed by a process that is gone, so boot recovery marks
-- them interrupted instead of the sweep running them days late or leaving
-- them at "running" forever. The migration runs before the new server
-- starts and the API runs as one copy, so no live job is caught.
UPDATE "TfJob"
SET "claimedAt" = CURRENT_TIMESTAMP, "claimedBy" = 'pre-0017'
WHERE "status" IN ('pending', 'running');
