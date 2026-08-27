-- Add status tracking and notes to community leads
ALTER TABLE "CommunityLead" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'new';
ALTER TABLE "CommunityLead" ADD COLUMN "notes" TEXT;
CREATE INDEX "CommunityLead_status_idx" ON "CommunityLead"("status");
