-- Codegen-driven Terraform projects.
--
-- A TfProject used to be template-shaped: it required a template version, had
-- no link back to an assessment, and a job could only record one rendered
-- file. Assessment-driven codegen has no template, is meaningful only in
-- relation to the assessment it came from, and writes a whole directory in one
-- commit. These columns make both shapes representable in the same tables.

-- TfProject: template version becomes optional, assessment linkage added.
ALTER TABLE "TfProject" ALTER COLUMN "templateVersionId" DROP NOT NULL;
ALTER TABLE "TfProject" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'template';
ALTER TABLE "TfProject" ADD COLUMN "assessmentId" TEXT;
ALTER TABLE "TfProject" ADD COLUMN "migrationTarget" TEXT;

-- An optional relation deletes to NULL rather than restricting, so the
-- existing constraints have to be replaced along with the column change.
ALTER TABLE "TfProject" DROP CONSTRAINT "TfProject_templateVersionId_fkey";
ALTER TABLE "TfProject"
  ADD CONSTRAINT "TfProject_templateVersionId_fkey"
  FOREIGN KEY ("templateVersionId") REFERENCES "TfTemplateVersion"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TfProject"
  ADD CONSTRAINT "TfProject_assessmentId_fkey"
  FOREIGN KEY ("assessmentId") REFERENCES "Assessment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "TfProject_assessmentId_idx" ON "TfProject"("assessmentId");

-- TfRendering: a codegen rendering has no template version.
ALTER TABLE "TfRendering" ALTER COLUMN "templateVersionId" DROP NOT NULL;
ALTER TABLE "TfRendering" DROP CONSTRAINT "TfRendering_templateVersionId_fkey";
ALTER TABLE "TfRendering"
  ADD CONSTRAINT "TfRendering_templateVersionId_fkey"
  FOREIGN KEY ("templateVersionId") REFERENCES "TfTemplateVersion"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- TfJob: kind discriminator, and commit metadata for multi-file jobs whose
-- commit cannot be recorded on a single rendering row.
ALTER TABLE "TfJob" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'template';
ALTER TABLE "TfJob" ADD COLUMN "commitSha" TEXT;
ALTER TABLE "TfJob" ADD COLUMN "fileCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TfJob" ALTER COLUMN "argumentsJson" SET DEFAULT '{}';
