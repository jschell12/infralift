-- Add providers array column to track which source hosting platforms are mentioned
ALTER TABLE "CommunityLead" ADD COLUMN "providers" TEXT[] NOT NULL DEFAULT '{}';
