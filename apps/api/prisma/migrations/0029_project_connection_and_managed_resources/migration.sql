-- A project's cloud account, and the ledger of what projects manage
-- (ADR 0010, ADR 0011).
--
-- 1. TfProject.providerConnectionId: the one ProviderConnection a project's
--    Terraform manages. Nullable, because rows made before this migration have
--    no such field, and some kinds never name one account.
-- 2. ManagedResource: one row per cloud resource a project manages, unique per
--    (connection, provider, inventory type, provider id), so one resource has
--    one owning project.
--
-- Reversing it, if it ever has to be: drop the table and the column. Nothing
-- else reads them, and the backfill below only copies a value that stays on
-- the assessment.
--   DROP TABLE "ManagedResource";
--   DROP INDEX "TfProject_providerConnectionId_idx";
--   ALTER TABLE "TfProject" DROP CONSTRAINT "TfProject_providerConnectionId_fkey";
--   ALTER TABLE "TfProject" DROP COLUMN "providerConnectionId";
--
-- Note: `prisma migrate diff` also reports Assessment_connectionId_fkey as
-- different from the schema. That predates this migration and is left alone.

-- AlterTable
ALTER TABLE "TfProject" ADD COLUMN "providerConnectionId" TEXT;

-- CreateTable
CREATE TABLE "ManagedResource" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "providerConnectionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "terraformAddress" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'adopted',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adoptedAt" TIMESTAMP(3),

    CONSTRAINT "ManagedResource_pkey" PRIMARY KEY ("id")
);

-- An adoption's rows, by status (confirm and release in services/managed-resources.ts).
CREATE INDEX "ManagedResource_projectId_status_idx" ON "ManagedResource"("projectId", "status");
CREATE INDEX "ManagedResource_orgId_idx" ON "ManagedResource"("orgId");

-- One owner per cloud resource. A second adoption of the same resource fails
-- with a unique violation (P2002), which the service turns into a 409. Its
-- leading column also serves the unmanaged view's read of one connection's rows.
CREATE UNIQUE INDEX "ManagedResource_providerConnectionId_provider_resourceType__key" ON "ManagedResource"("providerConnectionId", "provider", "resourceType", "providerId");

-- Deleting a connection checks for projects that manage its account.
CREATE INDEX "TfProject_providerConnectionId_idx" ON "TfProject"("providerConnectionId");

-- AddForeignKey
ALTER TABLE "TfProject" ADD CONSTRAINT "TfProject_providerConnectionId_fkey" FOREIGN KEY ("providerConnectionId") REFERENCES "ProviderConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManagedResource" ADD CONSTRAINT "ManagedResource_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManagedResource" ADD CONSTRAINT "ManagedResource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "TfProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManagedResource" ADD CONSTRAINT "ManagedResource_providerConnectionId_fkey" FOREIGN KEY ("providerConnectionId") REFERENCES "ProviderConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: a project made from an assessment of a connected account manages
-- that account. That is every codegen project and every adoption made from an
-- assessment, when the assessment ran against a stored connection of the same
-- org. Everything else stays null, because nothing on the row says which
-- account it manages:
--   - projects from a bundle assessment (the customer ran the collector; there
--     is no connection);
--   - template, stack and repository-import projects, and projects built
--     around Terraform Cloud workspaces (their tfcConnectionId is where state
--     lives, not the cloud account).
-- No ledger rows are backfilled: an adoption's import ids are in the files in
-- the customer's repository, not in this database, and guessing them from the
-- assessment would be a guess.
--
-- In production on 2026-11-12 there were 0 TfProject rows, so this touched
-- nothing there. To see what it would touch elsewhere, before deploying:
--   SELECT p.source, count(*) FROM "TfProject" p
--   JOIN "Assessment" a ON a.id = p."assessmentId"
--   WHERE a."connectionId" IS NOT NULL AND a."orgId" = p."orgId"
--   GROUP BY p.source;
UPDATE "TfProject" p
SET "providerConnectionId" = a."connectionId"
FROM "Assessment" a
WHERE a.id = p."assessmentId"
  AND a."connectionId" IS NOT NULL
  AND a."orgId" = p."orgId"
  AND p."providerConnectionId" IS NULL;
