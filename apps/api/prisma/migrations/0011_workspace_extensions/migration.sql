-- Projects backed by several workspaces, and workspaces adopted from the
-- customer's own HCP Terraform / Terraform Enterprise org.
--
-- A Workspace now has a kind. "adopted" is a workspace that already existed in
-- the customer's org: its code and state stay where they are, and infralift
-- records its variables and outputs so it can be templatized and extended, but
-- never pushes upgrades into it because it was handcrafted. "extension" is a
-- new workspace added to a project for new infrastructure, wired to the
-- outputs of the workspaces it depends on through WorkspaceDependency.
--
-- TfTemplate gains an orgId. Until now every template was one shared catalog.
-- An adopted workspace's template points at the customer's own repository, so
-- it is private to that org. RESTRICT rather than SET NULL on purpose: nulling
-- orgId is what promotes a template into the shared catalog, and an org delete
-- must never do that.

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "configCommitSha" TEXT,
ADD COLUMN     "connectionId" TEXT,
ADD COLUMN     "inputs" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'managed',
ADD COLUMN     "outputs" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "projectId" TEXT,
ADD COLUMN     "templateVersionId" TEXT,
ADD COLUMN     "tfcWorkspaceId" TEXT,
ADD COLUMN     "vcsRepo" TEXT,
ADD COLUMN     "workingDirectory" TEXT;

-- AlterTable
ALTER TABLE "TfTemplate" ADD COLUMN     "orgId" TEXT;

-- CreateTable
CREATE TABLE "WorkspaceDependency" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "dependsOnId" TEXT NOT NULL,
    "outputs" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceDependency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceDependency_dependsOnId_idx" ON "WorkspaceDependency"("dependsOnId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceDependency_workspaceId_dependsOnId_key" ON "WorkspaceDependency"("workspaceId", "dependsOnId");

-- CreateIndex
CREATE INDEX "Workspace_projectId_idx" ON "Workspace"("projectId");

-- CreateIndex
CREATE INDEX "TfTemplate_orgId_idx" ON "TfTemplate"("orgId");

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "TfProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ProviderConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "TfTemplateVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceDependency" ADD CONSTRAINT "WorkspaceDependency_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceDependency" ADD CONSTRAINT "WorkspaceDependency_dependsOnId_fkey" FOREIGN KEY ("dependsOnId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TfTemplate" ADD CONSTRAINT "TfTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

