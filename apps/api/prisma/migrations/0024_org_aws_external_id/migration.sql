-- AWS roles trust infralift's account on condition of an external ID, so a
-- role ARN alone is not enough to assume a customer's role (the confused-deputy
-- guard). Each org gets its own, minted on first use by services/aws-access.ts.
-- Existing orgs start with none.
ALTER TABLE "Org" ADD COLUMN "awsExternalId" TEXT;
CREATE UNIQUE INDEX "Org_awsExternalId_key" ON "Org"("awsExternalId");
