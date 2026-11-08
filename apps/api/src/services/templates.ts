import { prisma } from "../lib/db.js";
import { Conflict, NotFound, Unprocessable } from "../lib/errors.js";
import { renderTemplate, validateArguments, TfInputValidationError, type TfArguments } from "../lib/tf/render.js";

// ---------------------------------------------------------------------------
// Template projects (legacy /terraform page): one file rendered from a
// template version into a repository.
//
// TfTemplate is one catalog shared by every org (orgId null) plus each org's
// private templates (adopted workspaces). Every lookup by slug goes through
// visibleTemplates(), not just the listing, because a private template points
// at that customer's repository.
// ---------------------------------------------------------------------------

export function visibleTemplates(orgId: string) {
  return { OR: [{ orgId: null }, { orgId }] };
}

export function listTemplates(orgId: string) {
  return prisma.tfTemplate.findMany({
    where: visibleTemplates(orgId),
    include: {
      versions: {
        select: { id: true, releaseTag: true, inputSchema: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { slug: "asc" },
  });
}

export interface PublishInput {
  slug: string;
  name: string;
  description: string;
  releaseTag: string;
  templateBody: string;
  inputSchema: Record<string, unknown>;
}

/** Admin-only (the route checks): adds a version to the shared catalog. A slug
 *  that belongs to an org's private template cannot be taken over. */
export async function publishTemplate(input: PublishInput) {
  const existing = await prisma.tfTemplate.findUnique({ where: { slug: input.slug } });
  if (existing?.orgId) throw new Conflict("slug belongs to an org-private template");
  const template = await prisma.tfTemplate.upsert({
    where: { slug: input.slug },
    create: { slug: input.slug, name: input.name, description: input.description },
    update: { name: input.name, description: input.description },
  });
  const version = await prisma.tfTemplateVersion.create({
    data: {
      templateId: template.id,
      releaseTag: input.releaseTag,
      templateBody: input.templateBody,
      inputSchema: input.inputSchema as object,
    },
  });
  return { template, version };
}

async function visibleVersion(orgId: string, slug: string, releaseTag: string) {
  const template = await prisma.tfTemplate.findFirst({ where: { slug, ...visibleTemplates(orgId) } });
  if (!template) throw new NotFound("template not found");
  const version = await prisma.tfTemplateVersion.findUnique({
    where: { templateId_releaseTag: { templateId: template.id, releaseTag } },
  });
  if (!version) throw new NotFound("version not found");
  return version;
}

/** Dry-run render: validates the arguments and returns the body, touching
 *  neither git nor workspaces. */
export async function previewTemplate(orgId: string, slug: string, releaseTag: string, args: TfArguments) {
  const version = await visibleVersion(orgId, slug, releaseTag);
  try {
    validateArguments(version.inputSchema as object, args);
    return { rendered: renderTemplate(version.templateBody, args) };
  } catch (err) {
    if (err instanceof TfInputValidationError) throw new Unprocessable(err.details);
    throw err;
  }
}

export interface TemplateProjectInput {
  name: string;
  templateSlug: string;
  releaseTag: string;
  destRepo: string;
  destPath: string;
  destBranch: string;
  providerConfig: { name: string; source: string; version: string; region?: string };
}

export async function createTemplateProject(orgId: string, input: TemplateProjectInput) {
  const version = await visibleVersion(orgId, input.templateSlug, input.releaseTag);
  return prisma.tfProject.create({
    data: {
      orgId,
      name: input.name,
      templateVersionId: version.id,
      destRepo: input.destRepo,
      destPath: input.destPath,
      destBranch: input.destBranch,
      providerConfig: input.providerConfig,
    },
  });
}

/** A project's renderings. Scoped by org: a project id is guessable, and its
 *  renderings carry the customer's infrastructure. */
export async function listRenderings(orgId: string, projectId: string) {
  const project = await prisma.tfProject.findFirst({ where: { id: projectId, orgId }, select: { id: true } });
  if (!project) throw new NotFound("project not found");
  return prisma.tfRendering.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "desc" } });
}
