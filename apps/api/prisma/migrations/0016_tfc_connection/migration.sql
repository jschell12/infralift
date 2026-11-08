-- Which of the org's Terraform Cloud connections a project's workspace lives
-- in. Null = no workspace: infralift's own TFC organization is no longer used
-- for customer projects.

-- AlterTable
ALTER TABLE "TfProject" ADD COLUMN     "tfcConnectionId" TEXT;
