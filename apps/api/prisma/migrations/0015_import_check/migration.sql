-- The last result of an imported project's read-only plan check, as read back
-- from GitHub (lib/import/result.ts ImportCheckResult). Refreshed on read.

-- AlterTable
ALTER TABLE "TfProject" ADD COLUMN     "importCheckJson" JSONB;
