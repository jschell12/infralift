-- CreateTable
CREATE TABLE "CommunitySource" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "relevance" TEXT NOT NULL,
    "memberCount" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunitySource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommunitySource_slug_key" ON "CommunitySource"("slug");

-- CreateIndex
CREATE INDEX "CommunitySource_platform_idx" ON "CommunitySource"("platform");

-- CreateIndex
CREATE INDEX "CommunitySource_category_idx" ON "CommunitySource"("category");
