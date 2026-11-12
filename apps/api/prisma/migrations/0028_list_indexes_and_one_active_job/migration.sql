-- Indexes for the filters and sorts the list endpoints and the run guard use,
-- and one active job per project.
--
-- Plain CREATE INDEX (not CONCURRENTLY): the tables are small (11 assessments
-- in production when this was written) and prisma migrate deploy runs each
-- migration in a transaction, where CONCURRENTLY is not allowed.

-- Foreign keys Postgres does not index on its own. Every report read and every
-- cascade delete of an assessment filters on these.
CREATE INDEX "InventoryItem_assessmentId_idx" ON "InventoryItem"("assessmentId");
CREATE INDEX "Finding_assessmentId_idx" ON "Finding"("assessmentId");

-- GET /assessments: an org's assessments, newest first.
CREATE INDEX "Assessment_orgId_createdAt_idx" ON "Assessment"("orgId", "createdAt");
-- Deleting a connection checks for assessments that reference it.
CREATE INDEX "Assessment_connectionId_idx" ON "Assessment"("connectionId");
-- refuseConcurrentRun (services/assessments.ts): a run of this connection
-- still pending or running.
CREATE INDEX "Assessment_orgId_connectionId_status_idx" ON "Assessment"("orgId", "connectionId", "status");

-- GET /migrations: an org's migrations, newest first.
CREATE INDEX "Migration_orgId_createdAt_idx" ON "Migration"("orgId", "createdAt");

-- At most one pending or running job per project, so a double-click or a
-- second tab cannot start two jobs writing the same repository. The insert
-- that loses fails with a unique violation (P2002), which lib/jobs/enqueue.ts
-- turns into a 409. Errored and successful jobs are outside the index, so a
-- project keeps its full history. A job stuck at pending or running does not
-- block its project for good: the worker fails overdue and interrupted jobs
-- (lib/jobs/queue.ts).
--
-- Partial indexes cannot be declared in schema.prisma, so this one lives only
-- here; schema.prisma has a comment on TfJob pointing at it.
--
-- Jobs still pending or running now belong to the process this deploy just
-- stopped (one API copy at a time). If a project has more than one, keep the
-- newest and fail the rest, as 0017 did for jobs left over then, rather than
-- let the index fail to build and the server fail to boot. To see whether any
-- would be touched, before deploying:
--   SELECT "projectId", count(*) FROM "TfJob"
--   WHERE "status" IN ('pending', 'running') GROUP BY 1 HAVING count(*) > 1;
WITH ranked AS (
  SELECT "id",
         row_number() OVER (PARTITION BY "projectId" ORDER BY "createdAt" DESC, "id" DESC) AS position
  FROM "TfJob"
  WHERE "status" IN ('pending', 'running')
)
UPDATE "TfJob"
SET "status" = 'errored',
    "statusMessage" = 'superseded: a newer job for this project was queued while this one was waiting; start it again if it is still needed.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (SELECT "id" FROM ranked WHERE position > 1);

CREATE UNIQUE INDEX "TfJob_projectId_active_key" ON "TfJob"("projectId")
WHERE "status" IN ('pending', 'running');
