-- Template, codegen and stack jobs now record the Terraform Cloud workspace
-- they create or reuse, keyed on (org, TFC workspace id) so a rerun finds its
-- row. Rows without a TFC workspace id are NULL and do not collide.
--
-- Fails if an org already has two rows for one TFC workspace. Check first:
--   SELECT "orgId", "tfcWorkspaceId", count(*) FROM "Workspace"
--   WHERE "tfcWorkspaceId" IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;
CREATE UNIQUE INDEX "Workspace_orgId_tfcWorkspaceId_key" ON "Workspace"("orgId", "tfcWorkspaceId");
