-- Workspaces infralift created in a customer's Terraform Cloud were API-driven,
-- so a merge never planned. A tfc connection now names the VCS OAuth token
-- (ot-...) its workspaces are linked through. Null until the customer picks one.
ALTER TABLE "ProviderConnection" ADD COLUMN "vcsOauthTokenId" TEXT;
