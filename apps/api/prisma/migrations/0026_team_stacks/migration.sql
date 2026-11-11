-- Team stacks (ADR 0009): a stack kept in a team's own repository, pinned per
-- version to the commit its ref resolved to. Private to the org unless
-- published and approved. Catalog stacks stay on disk (TfProject.stackSlug).
CREATE TABLE "StackSource" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "gitHost" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "path" TEXT NOT NULL DEFAULT '',
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "publishedVersionId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StackSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StackVersion" (
    "id" TEXT NOT NULL,
    "stackSourceId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "resolvedSha" TEXT NOT NULL,
    "manifest" JSONB,
    "files" JSONB NOT NULL,
    "contents" JSONB,
    "valid" BOOLEAN NOT NULL,
    "validation" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StackVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StackSource_orgId_gitHost_repo_path_key" ON "StackSource"("orgId", "gitHost", "repo", "path");
CREATE INDEX "StackSource_visibility_idx" ON "StackSource"("visibility");
CREATE UNIQUE INDEX "StackVersion_stackSourceId_resolvedSha_key" ON "StackVersion"("stackSourceId", "resolvedSha");

ALTER TABLE "StackSource" ADD CONSTRAINT "StackSource_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StackSource" ADD CONSTRAINT "StackSource_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ProviderConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StackVersion" ADD CONSTRAINT "StackVersion_stackSourceId_fkey" FOREIGN KEY ("stackSourceId") REFERENCES "StackSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Projects made from a team stack render from one pinned version.
ALTER TABLE "TfProject" ADD COLUMN "stackVersionId" TEXT;
ALTER TABLE "TfProject" ADD CONSTRAINT "TfProject_stackVersionId_fkey" FOREIGN KEY ("stackVersionId") REFERENCES "StackVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
