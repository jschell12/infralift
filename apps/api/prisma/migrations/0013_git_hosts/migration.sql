-- Stack projects can live on GitHub or GitLab, and can start greenfield: the
-- first job creates the repository from the stack's app template, then lands
-- the infrastructure in it as a pull or merge request.

-- AlterTable
ALTER TABLE "TfProject" ADD COLUMN     "createRepo" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "gitConnectionId" TEXT,
ADD COLUMN     "gitHost" TEXT NOT NULL DEFAULT 'github';
