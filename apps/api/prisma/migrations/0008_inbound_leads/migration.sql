-- Inbound leads: people who asked us for an assessment through the marketing
-- site. Kept separate from CommunityLead, which is shaped for scraped forum
-- posts and has no email field.

CREATE TABLE "InboundLead" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "company" TEXT,
    "provider" TEXT,
    "monthlySpend" TEXT,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "sourcePath" TEXT,
    "referrer" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "country" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboundLead_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InboundLead_status_createdAt_idx" ON "InboundLead"("status", "createdAt");
CREATE INDEX "InboundLead_createdAt_idx" ON "InboundLead"("createdAt");
