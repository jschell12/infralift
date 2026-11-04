-- Stack projects: a whole deploy setup (infrastructure, server scripts, CI
-- workflows) rendered from apps/api/stacks/<slug> into the customer's app
-- repository. It lands as a pull request, whose URL the job records.

-- AlterTable
ALTER TABLE "TfProject" ADD COLUMN     "stackSlug" TEXT;

-- AlterTable
ALTER TABLE "TfJob" ADD COLUMN     "prUrl" TEXT;
