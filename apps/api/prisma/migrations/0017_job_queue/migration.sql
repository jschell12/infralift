-- Job queue: a job is claimed by exactly one API process before it runs.
-- claimedBy names the process, so one that starts after a restart can tell
-- which unfinished jobs were left behind by a process that is gone.

-- AlterTable
ALTER TABLE "TfJob" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedBy" TEXT;

-- CreateIndex
CREATE INDEX "TfJob_status_claimedAt_idx" ON "TfJob"("status", "claimedAt");
