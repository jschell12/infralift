-- CreateTable
CREATE TABLE "CommunityLead" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorName" TEXT,
    "classification" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "engagementScore" INTEGER,
    "postedAt" TIMESTAMP(3),
    "scrapedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityLead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommunityLead_sourceId_platform_key" ON "CommunityLead"("sourceId", "platform");

-- CreateIndex
CREATE INDEX "CommunityLead_communityId_idx" ON "CommunityLead"("communityId");

-- CreateIndex
CREATE INDEX "CommunityLead_classification_idx" ON "CommunityLead"("classification");

-- CreateIndex
CREATE INDEX "CommunityLead_scrapedAt_idx" ON "CommunityLead"("scrapedAt");

-- AddForeignKey
ALTER TABLE "CommunityLead" ADD CONSTRAINT "CommunityLead_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "CommunitySource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
