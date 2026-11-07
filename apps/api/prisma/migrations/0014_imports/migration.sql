-- Imported projects: an existing Terraform root module in the customer's
-- repository. importJson holds what the scan found (backend, providers,
-- resource counts, the secrets the read-only plan check needs).

-- AlterTable
ALTER TABLE "TfProject" ADD COLUMN     "importJson" JSONB;
