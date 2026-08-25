warn The configuration property `package.json#prisma` is deprecated and will be removed in Prisma 7. Please migrate to a Prisma config file (e.g., `prisma.config.ts`).
For more information, see: https://pris.ly/prisma-config

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Org" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Org_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "orgId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unverified',
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assessment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "error" TEXT,
    "resourceCount" INTEGER NOT NULL DEFAULT 0,
    "estimatedMonthlyCostCents" INTEGER,
    "estimatedMonthlySavingsCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Assessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT,
    "monthlyCostCents" INTEGER,
    "metadata" JSONB,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "monthlySavingsCents" INTEGER,
    "resourceRef" TEXT,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Migration" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sourceProvider" TEXT NOT NULL,
    "targetPlatform" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "fixedFeeCents" INTEGER,
    "repoUrl" TEXT,
    "tfcOrg" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Migration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationPhase" (
    "id" TEXT NOT NULL,
    "migrationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "MigrationPhase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tfcWorkspaceUrl" TEXT,
    "driftDetected" BOOLEAN NOT NULL DEFAULT false,
    "lastRunStatus" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostingProvider" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "websiteUrl" TEXT NOT NULL,
    "pricingModel" TEXT NOT NULL,
    "minMonthlyCents" INTEGER NOT NULL,
    "typicalMonthlyCents" INTEGER NOT NULL,
    "benefits" TEXT NOT NULL,
    "drawbacks" TEXT NOT NULL,
    "managedLevel" INTEGER NOT NULL,
    "egressFreeGb" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "HostingProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountProgram" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "creditMaxCents" INTEGER,
    "creditDurationMonths" INTEGER,
    "creditMonthlyCapCents" INTEGER,
    "confidence" TEXT NOT NULL,
    "sourceNote" TEXT,
    "sourceDate" TEXT,
    "notes" TEXT,

    CONSTRAINT "DiscountProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountTier" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "minAnnualCommitUsd" INTEGER NOT NULL,
    "discountBps" INTEGER NOT NULL,

    CONSTRAINT "DiscountTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCapability" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "score" INTEGER NOT NULL,

    CONSTRAINT "ProviderCapability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderPlan" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthlyCents" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    "includedNotes" TEXT NOT NULL,

    CONSTRAINT "ProviderPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppProfile" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "runtime" TEXT NOT NULL,
    "requiredCapabilities" TEXT[],
    "preferredCapabilities" TEXT[],
    "budgetMonthlyCents" INTEGER NOT NULL,
    "opsTolerance" INTEGER NOT NULL DEFAULT 1,
    "trafficGbMonth" INTEGER NOT NULL DEFAULT 10,
    "annualSpendCents" INTEGER,
    "startupCreditsEligible" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TfTemplate" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'hcl',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TfTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TfTemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "releaseTag" TEXT NOT NULL,
    "templateBody" TEXT NOT NULL,
    "inputSchema" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TfTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TfProject" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "templateVersionId" TEXT NOT NULL,
    "destRepo" TEXT NOT NULL,
    "destPath" TEXT NOT NULL DEFAULT '',
    "destBranch" TEXT NOT NULL DEFAULT 'main',
    "providerConfig" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TfProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TfRendering" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "templateVersionId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "argumentsJson" JSONB NOT NULL,
    "renderedBody" TEXT NOT NULL,
    "commitSha" TEXT,
    "managed" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TfRendering_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TfJob" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "statusMessage" TEXT NOT NULL DEFAULT '',
    "argumentsJson" JSONB NOT NULL,
    "renderingId" TEXT,
    "workspaceName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TfJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "LoginToken_token_key" ON "LoginToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderConnection_orgId_provider_label_key" ON "ProviderConnection"("orgId", "provider", "label");

-- CreateIndex
CREATE UNIQUE INDEX "MigrationPhase_migrationId_key_key" ON "MigrationPhase"("migrationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_orgId_name_key" ON "Workspace"("orgId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "HostingProvider_slug_key" ON "HostingProvider"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountProgram_providerId_name_key" ON "DiscountProgram"("providerId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountTier_programId_minAnnualCommitUsd_key" ON "DiscountTier"("programId", "minAnnualCommitUsd");

-- CreateIndex
CREATE INDEX "ProviderCapability_key_idx" ON "ProviderCapability"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCapability_providerId_key_key" ON "ProviderCapability"("providerId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderPlan_providerId_name_key" ON "ProviderPlan"("providerId", "name");

-- CreateIndex
CREATE INDEX "AppProfile_orgId_idx" ON "AppProfile"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "TfTemplate_slug_key" ON "TfTemplate"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "TfTemplateVersion_templateId_releaseTag_key" ON "TfTemplateVersion"("templateId", "releaseTag");

-- CreateIndex
CREATE UNIQUE INDEX "TfProject_orgId_name_key" ON "TfProject"("orgId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TfRendering_projectId_fileName_key" ON "TfRendering"("projectId", "fileName");

-- CreateIndex
CREATE INDEX "TfJob_projectId_createdAt_idx" ON "TfJob"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginToken" ADD CONSTRAINT "LoginToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderConnection" ADD CONSTRAINT "ProviderConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ProviderConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "Assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "Assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Migration" ADD CONSTRAINT "Migration_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationPhase" ADD CONSTRAINT "MigrationPhase_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "Migration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountProgram" ADD CONSTRAINT "DiscountProgram_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "HostingProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountTier" ADD CONSTRAINT "DiscountTier_programId_fkey" FOREIGN KEY ("programId") REFERENCES "DiscountProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCapability" ADD CONSTRAINT "ProviderCapability_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "HostingProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderPlan" ADD CONSTRAINT "ProviderPlan_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "HostingProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TfTemplateVersion" ADD CONSTRAINT "TfTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "TfTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TfProject" ADD CONSTRAINT "TfProject_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "TfTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TfRendering" ADD CONSTRAINT "TfRendering_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "TfProject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TfRendering" ADD CONSTRAINT "TfRendering_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "TfTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TfJob" ADD CONSTRAINT "TfJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "TfProject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TfJob" ADD CONSTRAINT "TfJob_renderingId_fkey" FOREIGN KEY ("renderingId") REFERENCES "TfRendering"("id") ON DELETE SET NULL ON UPDATE CASCADE;
┌─────────────────────────────────────────────────────────┐
│  Update available 6.19.3 -> 8.0.0-rc.10                 │
│                                                         │
│  This is a major update - please follow the guide at    │
│  https://pris.ly/d/major-version-upgrade                │
│                                                         │
│  Run the following to update                            │
│    npm i --save-dev prisma@latest                       │
│    npm i @prisma/client@latest                          │
└─────────────────────────────────────────────────────────┘

