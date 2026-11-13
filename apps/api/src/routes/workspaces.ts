import { Router } from "express";
import { AppError, Conflict, InvalidBody, InvalidInput, NotFound, Unprocessable, Upstream, handle, parseBody } from "../lib/errors.js";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { encryptToken, decryptToken } from "../lib/crypto.js";
import { isSafePath } from "../lib/import/check.js";
import * as runs from "../services/workspace-runs.js";
import { TfcClient, TfcClientError, tfcBaseUrl } from "../lib/tf/tfc-client.js";
import {
  DependencyCycleError,
  DependencyGraphError,
  NotTemplatizableError,
  UnsafeHostError,
  assertPublicHost,
  extensionMarker,
  WiringError,
  adoptedTemplateSlug,
  applyOrder,
  destroyOrder,
  missingOutputs,
  renderWiring,
  snapshotInputs,
  templatizeAdopted,
  tfcCredentialSchema,
  type StoredInput,
  type TfcCredential,
} from "../lib/tf/extensions.js";

export const workspacesRouter = Router();

// ProviderConnection.provider for a customer's HCP Terraform / TFE org. Not in
// the shared PROVIDERS list: that list is assessment sources, and this is
// where runs happen, not something to assess.
export const TFC_PROVIDER = "tfc";

function workspaceUrl(cred: TfcCredential, name: string): string {
  return `https://${cred.hostname}/app/${cred.organization}/workspaces/${name}`;
}

/**
 * The org's TFC connection, decrypted. Always scoped by orgId. NotFound when
 * the connection is missing, InvalidInput when its host now resolves
 * somewhere private.
 */
async function loadTfc(orgId: string, connectionId: string) {
  const conn = await prisma.providerConnection.findFirst({
    where: { id: connectionId, orgId, provider: TFC_PROVIDER },
  });
  if (!conn) throw new NotFound("connection not found");
  const cred = tfcCredentialSchema.parse(JSON.parse(decryptToken(conn.encryptedToken)));
  try {
    await assertPublicHost(cred.hostname);
  } catch (err) {
    if (!(err instanceof UnsafeHostError)) throw err;
    throw new InvalidInput(err.message);
  }
  const client = new TfcClient(cred.token, cred.organization, tfcBaseUrl(cred.hostname));
  return { conn, cred, client };
}

/**
 * Anything that went wrong talking to the customer's TFC becomes a 502
 * (Upstream). Measured on 2026-10-08: an unexpected `null` body from TFC took
 * the process down when it escaped a handler, so every TFC call is wrapped.
 */
function tfcFailure(err: unknown): never {
  // An answer this handler decided on (not found, conflict) passes through.
  if (err instanceof AppError) throw err;
  if (err instanceof TfcClientError) {
    // The customer's own org answered; pass the status class through without
    // the body, which can echo request detail.
    throw new Upstream(`Terraform Cloud returned ${err.statusCode} for ${err.method} ${err.path}`);
  }
  console.error("terraform cloud call failed:", err);
  throw new Upstream("could not complete the request to Terraform Cloud");
}

// -- list ----------------------------------------------------------------------

workspacesRouter.get("/", handle(async (req, res) => {
  const { orgId } = req.user!;
  // Only the listed columns (not the inputs and outputs snapshots), and at
  // most 500: an adopted TFC org can be large, but this is a ceiling, not a
  // page size.
  const workspaces = await prisma.workspace.findMany({
    where: { orgId },
    orderBy: { name: "asc" },
    take: 500,
    select: {
      id: true,
      name: true,
      kind: true,
      projectId: true,
      tfcWorkspaceUrl: true,
      driftDetected: true,
      lastRunStatus: true,
      lastRunAt: true,
      vcsRepo: true,
      connectionId: true,
    },
  });
  res.json(
    workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      kind: w.kind,
      projectId: w.projectId,
      tfcWorkspaceUrl: w.tfcWorkspaceUrl,
      driftDetected: w.driftDetected,
      lastRunStatus: w.lastRunStatus,
      lastRunAt: w.lastRunAt?.toISOString() ?? null,
      vcsRepo: w.vcsRepo,
      connectionId: w.connectionId,
    }))
  );
}));

// -- connect an HCP Terraform / TFE org ---------------------------------------------

const connectionSchema = z.object({
  label: z.string().min(1).max(120),
  hostname: z.string().optional(),
  organization: z.string().min(1),
  token: z.string().min(1),
});

workspacesRouter.post("/connections", handle(async (req, res) => {
  const parsed = connectionSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new InvalidBody(parsed.error.flatten());
  }
  const credParsed = tfcCredentialSchema.safeParse({
    hostname: parsed.data.hostname || undefined,
    organization: parsed.data.organization,
    token: parsed.data.token,
  });
  if (!credParsed.success) {
    throw new InvalidBody(credParsed.error.flatten());
  }
  const cred = credParsed.data;
  try {
    await assertPublicHost(cred.hostname);
  } catch (err) {
    if (!(err instanceof UnsafeHostError)) throw err;
    throw new InvalidInput(err.message);
  }
  const client = new TfcClient(cred.token, cred.organization, tfcBaseUrl(cred.hostname));
  let valid = false;
  try {
    valid = await client.canReadOrganization();
  } catch {
    valid = false;
  }
  let conn;
  try {
    conn = await prisma.providerConnection.create({
      data: {
        orgId: req.user!.orgId,
        provider: TFC_PROVIDER,
        label: parsed.data.label,
        encryptedToken: encryptToken(JSON.stringify(cred)),
        status: valid ? "valid" : "invalid",
        lastVerifiedAt: valid ? new Date() : null,
        lastCheckedAt: new Date(),
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new Conflict(`a Terraform Cloud connection labelled "${parsed.data.label}" already exists`);
    }
    throw err;
  }
  res.status(201).json({
    id: conn.id,
    provider: conn.provider,
    label: conn.label,
    hostname: cred.hostname,
    organization: cred.organization,
    status: conn.status,
  });
}));

// -- browse the customer's workspaces -------------------------------------------------

workspacesRouter.get("/remote", handle(async (req, res) => {
  const { orgId } = req.user!;
  const tfc = await loadTfc(orgId, String(req.query.connectionId ?? ""));
  try {
    const [{ workspaces: remote, truncated }, local] = await Promise.all([
      tfc.client.listWorkspacesCapped(),
      prisma.workspace.findMany({
        where: { orgId, connectionId: tfc.conn.id },
        select: { id: true, tfcWorkspaceId: true, kind: true },
      }),
    ]);
    const byTfcId = new Map(local.map((w) => [w.tfcWorkspaceId, w]));
    // The body stays a plain array for the dashboard; a listing cut off at
    // TFC_WORKSPACE_PAGES says so in a header.
    if (truncated) res.setHeader("Infralift-Truncated", "true");
    res.json(
      remote.map((w) => ({
        tfcWorkspaceId: w.id,
        name: w.name,
        vcsRepo: w.vcsRepo,
        workingDirectory: w.workingDirectory,
        resourceCount: w.resourceCount,
        latestRunStatus: w.latestRunStatus,
        infralift: byTfcId.get(w.id) ?? null,
      }))
    );
  } catch (err) {
    tfcFailure(err);
  }
}));

// -- adopt an existing workspace ------------------------------------------------------

const projectName = z.string().min(1).max(32).regex(/^[a-z0-9-]+$/);

const adoptSchema = z
  .object({
    connectionId: z.string().min(1),
    workspaceName: z.string().min(1).max(90),
    projectId: z.string().min(1).optional(),
    projectName: projectName.optional(),
  })
  .refine((d) => Boolean(d.projectId) !== Boolean(d.projectName), {
    message: "give exactly one of projectId or projectName",
  });

workspacesRouter.post("/adopt", handle(async (req, res) => {
  const parsed = adoptSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new InvalidBody(parsed.error.flatten());
  }
  const { orgId } = req.user!;
  const d = parsed.data;
  const tfc = await loadTfc(orgId, d.connectionId);

  let remote, vars, outputs, ingress;
  try {
    remote = await tfc.client.getWorkspace(d.workspaceName);
    if (!remote) throw new NotFound("workspace not found in Terraform Cloud");
    [vars, outputs, ingress] = await Promise.all([
      tfc.client.listVariables(remote.id),
      tfc.client.listCurrentOutputs(remote.id),
      remote.currentConfigVersionId
        ? tfc.client.getIngress(remote.currentConfigVersionId)
        : Promise.resolve(null),
    ]);
  } catch (err) {
    tfcFailure(err);
  }

  const existing = await prisma.workspace.findUnique({
    where: { orgId_name: { orgId, name: remote.name } },
  });
  if (existing && existing.kind !== "adopted") {
    throw new Conflict(`"${remote.name}" is already an infralift ${existing.kind} workspace`);
  }

  // Re-adopting refreshes the snapshot. It must not move the workspace to a
  // different project, connection or TFC workspace: extensions depending on
  // it would be left pointing across projects, or across TFC orgs. Checked
  // before any project is created, so a refusal leaves nothing behind.
  if (existing) {
    const targetProjectId = d.projectId
      ? d.projectId
      : ((await prisma.tfProject.findUnique({
          where: { orgId_name: { orgId, name: d.projectName! } },
          select: { id: true },
        }))?.id ?? null);
    // A null connection means the old one was deleted (SET NULL); reconnecting
    // and re-adopting is the recovery, and tfcWorkspaceId still pins it to
    // the same TFC workspace.
    const moved =
      (existing.connectionId !== null && existing.connectionId !== tfc.conn.id) ||
      existing.tfcWorkspaceId !== remote.id ||
      (existing.projectId !== null && existing.projectId !== targetProjectId);
    if (moved) {
      throw new Conflict(`"${remote.name}" is already adopted into another project or from another connection`);
    }
  }

  let project;
  if (d.projectId) {
    project = await prisma.tfProject.findFirst({ where: { id: d.projectId, orgId } });
    if (!project) throw new NotFound("project not found");
  } else {
    project =
      (await prisma.tfProject.findUnique({
        where: { orgId_name: { orgId, name: d.projectName! } },
      })) ??
      (await prisma.tfProject.create({
        data: {
          orgId,
          name: d.projectName!,
          source: "adopted",
          destRepo: remote.vcsRepo ?? "",
          destBranch: remote.vcsBranch ?? "main",
          destPath: remote.workingDirectory ?? "",
          providerConfig: {},
        },
      }));
  }

  const inputs: StoredInput[] = snapshotInputs(vars);
  const commitSha = ingress?.commitSha ?? null;

  // Templatize when there is a pinned source. A CLI-driven workspace is still
  // adopted; it just cannot be reused as a template.
  let template:
    | { status: "created"; slug: string; releaseTag: string; skipped: { key: string; reason: string }[] }
    | { status: "unavailable"; reason: string };
  let templateVersionId: string | null = null;
  try {
    const t = templatizeAdopted({
      workspaceName: remote.name,
      repoUrl: remote.vcsRepoUrl,
      workingDirectory: remote.workingDirectory,
      commitSha,
      inputs,
    });
    const slug = adoptedTemplateSlug(orgId, remote.name);
    const releaseTag = commitSha!.slice(0, 12);
    const tpl = await prisma.tfTemplate.upsert({
      where: { slug },
      create: {
        slug,
        orgId,
        name: `${remote.name} (adopted)`,
        description: `Adopted from ${remote.vcsRepo ?? "TFC"} at ${releaseTag}. Frozen.`,
      },
      update: {},
    });
    if (tpl.orgId !== orgId) {
      // The slug embeds the org id, so this means a bug, not a race. Refuse
      // rather than attach a version to another org's template.
      throw new Error(`adopted template slug ${slug} belongs to another org`);
    }
    const version = await prisma.tfTemplateVersion.upsert({
      where: { templateId_releaseTag: { templateId: tpl.id, releaseTag } },
      create: {
        templateId: tpl.id,
        releaseTag,
        templateBody: t.templateBody,
        inputSchema: t.inputSchema as object,
      },
      update: {},
    });
    templateVersionId = version.id;
    template = { status: "created", slug, releaseTag, skipped: t.skipped };
  } catch (err) {
    if (!(err instanceof NotTemplatizableError)) throw err;
    template = { status: "unavailable", reason: err.message };
  }

  const data = {
    projectId: project.id,
    kind: "adopted",
    connectionId: tfc.conn.id,
    tfcWorkspaceId: remote.id,
    tfcWorkspaceUrl: workspaceUrl(tfc.cred, remote.name),
    vcsRepo: remote.vcsRepo,
    workingDirectory: remote.workingDirectory,
    configCommitSha: commitSha,
    inputs: inputs as object[],
    outputs: outputs as object[],
    lastRunStatus: remote.latestRunStatus,
    templateVersionId,
  };
  const workspace = await prisma.workspace.upsert({
    where: { orgId_name: { orgId, name: remote.name } },
    create: { orgId, name: remote.name, ...data },
    update: data,
  });

  res.status(existing ? 200 : 201).json({
    workspace: {
      id: workspace.id,
      name: workspace.name,
      kind: workspace.kind,
      projectId: project.id,
      tfcWorkspaceUrl: workspace.tfcWorkspaceUrl,
      inputs: inputs.length,
      outputs: outputs.map((o) => o.name),
    },
    template,
  });
}));

// -- a project's workspace graph ------------------------------------------------------

async function projectGraph(orgId: string, projectId: string) {
  const project = await prisma.tfProject.findFirst({
    where: { id: projectId, orgId },
    select: { id: true, name: true },
  });
  if (!project) return null;
  const workspaces = await prisma.workspace.findMany({
    where: { orgId, projectId },
    include: { dependsOn: true },
    orderBy: { name: "asc" },
  });
  const edges = workspaces.flatMap((w) =>
    w.dependsOn.map((dep) => ({ workspaceId: w.id, dependsOnId: dep.dependsOnId }))
  );
  return { project, workspaces, edges };
}

workspacesRouter.get("/projects/:projectId", handle(async (req, res) => {
  const g = await projectGraph(req.user!.orgId, req.params.projectId);
  if (!g) throw new NotFound("project not found");
  const ids = g.workspaces.map((w) => w.id);
  const name = new Map(g.workspaces.map((w) => [w.id, w.name]));
  let order: { apply: string[]; destroy: string[] } | { cycle: string[] } | { inconsistent: string };
  try {
    order = {
      apply: applyOrder(ids, g.edges).map((id) => name.get(id)!),
      destroy: destroyOrder(ids, g.edges).map((id) => name.get(id)!),
    };
  } catch (err) {
    if (err instanceof DependencyCycleError) {
      order = { cycle: err.cycle.map((id) => name.get(id)!) };
    } else if (err instanceof DependencyGraphError) {
      order = { inconsistent: err.message };
    } else {
      throw err;
    }
  }
  res.json({
    project: g.project,
    workspaces: g.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      kind: w.kind,
      tfcWorkspaceUrl: w.tfcWorkspaceUrl,
      configCommitSha: w.configCommitSha,
      outputs: w.outputs,
      dependsOn: w.dependsOn.map((dep) => ({
        workspaceId: dep.dependsOnId,
        outputs: dep.outputs,
      })),
    })),
    order,
  });
}));

/** Apply order by name, or null when the stored graph is inconsistent. */
function safeOrder(
  ids: string[],
  edges: { workspaceId: string; dependsOnId: string }[],
  name: Map<string, string>
): string[] | null {
  try {
    return applyOrder(ids, edges).map((id) => name.get(id)!);
  } catch (err) {
    if (err instanceof DependencyGraphError) return null;
    throw err;
  }
}

// -- add an extension workspace ---------------------------------------------------------

const extensionSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,90}$/),
  connectionId: z.string().min(1),
  dependsOn: z
    .array(
      z.object({
        workspaceId: z.string().min(1),
        outputs: z.record(z.string(), z.string()).default({}),
      })
    )
    .default([]),
});

workspacesRouter.post("/projects/:projectId/extensions", handle(async (req, res) => {
  const parsed = extensionSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new InvalidBody(parsed.error.flatten());
  }
  const { orgId } = req.user!;
  const d = parsed.data;
  const g = await projectGraph(orgId, req.params.projectId);
  if (!g) throw new NotFound("project not found");
  const tfc = await loadTfc(orgId, d.connectionId);

  if (await prisma.workspace.findUnique({ where: { orgId_name: { orgId, name: d.name } } })) {
    throw new Conflict(`workspace "${d.name}" already exists`);
  }

  // Bases must be in this project, and in the same TFC org as the extension:
  // remote state sharing does not cross organizations.
  const byId = new Map(g.workspaces.map((w) => [w.id, w]));
  const problems: string[] = [];
  for (const dep of d.dependsOn) {
    const base = byId.get(dep.workspaceId);
    if (!base) {
      problems.push(`${dep.workspaceId}: not a workspace in this project`);
      continue;
    }
    if (!base.tfcWorkspaceId || base.connectionId !== tfc.conn.id) {
      problems.push(`${base.name}: not in the same Terraform Cloud organization`);
      continue;
    }
    const missing = missingOutputs(dep.outputs, base.outputs as { name: string }[]);
    if (missing.length) problems.push(`${base.name}: no output named ${missing.join(", ")}`);
  }
  if (new Set(d.dependsOn.map((x) => x.workspaceId)).size !== d.dependsOn.length) {
    problems.push("a base workspace is listed more than once");
  }
  if (problems.length) throw new Unprocessable(problems);

  // Render before touching the customer's org, so a bad name fails here.
  let wiring: string;
  try {
    wiring = renderWiring({
      hostname: tfc.cred.hostname,
      organization: tfc.cred.organization,
      bases: d.dependsOn.map((dep) => ({
        workspaceName: byId.get(dep.workspaceId)!.name,
        outputs: dep.outputs,
      })),
    });
  } catch (err) {
    if (err instanceof WiringError) throw new Unprocessable([err.message]);
    throw err;
  }

  // Create in TFC, then share state and add run triggers from each base.
  // A workspace that already exists is reused only if infralift created it
  // for this project on an earlier attempt, recognised by its description.
  // Anything else with that name is the customer's own, and wiring state and
  // run triggers into it would be taking it over.
  const marker = extensionMarker(g.project.id);
  let remote;
  try {
    const made = await tfc.client.createWorkspaceExclusive(d.name, {
      autoApply: false,
      description: marker,
    });
    if (!made.created && made.workspace.description !== marker) {
      throw new Conflict(`"${d.name}" already exists in your Terraform Cloud organization. Adopt it, or pick another name.`);
    }
    remote = made.workspace;
    for (const dep of d.dependsOn) {
      const baseTfcId = byId.get(dep.workspaceId)!.tfcWorkspaceId!;
      await tfc.client.addRemoteStateConsumers(baseTfcId, [remote.id]);
      await tfc.client.ensureRunTrigger(remote.id, baseTfcId);
    }
  } catch (err) {
    tfcFailure(err);
  }

  const workspace = await prisma.$transaction(async (tx) => {
    const ws = await tx.workspace.create({
      data: {
        orgId,
        name: d.name,
        projectId: g.project.id,
        kind: "extension",
        connectionId: tfc.conn.id,
        tfcWorkspaceId: remote.id,
        tfcWorkspaceUrl: workspaceUrl(tfc.cred, d.name),
      },
    });
    for (const dep of d.dependsOn) {
      await tx.workspaceDependency.create({
        data: { workspaceId: ws.id, dependsOnId: dep.workspaceId, outputs: dep.outputs },
      });
    }
    return ws;
  });

  const ids = [...g.workspaces.map((w) => w.id), workspace.id];
  const edges = [
    ...g.edges,
    ...d.dependsOn.map((dep) => ({ workspaceId: workspace.id, dependsOnId: dep.workspaceId })),
  ];
  const name = new Map([...g.workspaces.map((w) => [w.id, w.name] as const), [workspace.id, d.name]]);

  res.status(201).json({
    workspace: {
      id: workspace.id,
      name: workspace.name,
      kind: workspace.kind,
      tfcWorkspaceUrl: workspace.tfcWorkspaceUrl,
    },
    // Not committed anywhere yet: the extension's own code goes beside it.
    files: [{ path: "deps.tf", body: wiring }],
    applyOrder: safeOrder(ids, edges, name),
  });
}));

// -- refresh outputs --------------------------------------------------------------

// Output names are what other workspaces can wire to. An extension has none
// when it is created; after its first apply, refresh them so it can in turn be
// a base.
workspacesRouter.post("/:id/outputs/refresh", handle(async (req, res) => {
  const { orgId } = req.user!;
  const ws = await prisma.workspace.findFirst({ where: { id: req.params.id, orgId } });
  if (!ws) throw new NotFound("workspace not found");
  if (!ws.connectionId || !ws.tfcWorkspaceId) {
    throw new Conflict("workspace is not linked to a Terraform Cloud workspace");
  }
  const tfc = await loadTfc(orgId, ws.connectionId);
  let outputs;
  try {
    outputs = await tfc.client.listCurrentOutputs(ws.tfcWorkspaceId);
  } catch (err) {
    tfcFailure(err);
  }
  await prisma.workspace.update({ where: { id: ws.id }, data: { outputs: outputs as object[] } });
  res.json({ id: ws.id, outputs: outputs.map((o) => o.name) });
}));

// -- VCS link and runs (services/workspace-runs.ts) ---------------------------------

const oauthTokenId = z.string().regex(/^ot-[A-Za-z0-9]+$/);

workspacesRouter.get("/connections/:connectionId/oauth-tokens", handle(async (req, res) => {
  res.json(await runs.listOAuthTokens(req.user!.orgId, req.params.connectionId));
}));

workspacesRouter.put("/connections/:connectionId/oauth-token", handle(async (req, res) => {
  const body = parseBody(z.object({ oauthTokenId }), req.body);
  res.json(await runs.selectOAuthToken(req.user!.orgId, req.params.connectionId, body.oauthTokenId));
}));

const linkSchema = z.object({
  repo: z.string().max(200).regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/, "owner/repo"),
  branch: z.string().max(200).regex(/^[A-Za-z0-9._\/-]+$/).optional(),
  workingDirectory: z.string().max(200).refine((p) => p === "" || (isSafePath(p) && !p.startsWith("/")), "a relative path").optional(),
  oauthTokenId: oauthTokenId.optional(),
});

workspacesRouter.post("/:id/vcs", handle(async (req, res) => {
  res.json(await runs.linkRepository(req.user!.orgId, req.params.id, parseBody(linkSchema, req.body)));
}));

workspacesRouter.get("/:id/runs", handle(async (req, res) => {
  res.json(await runs.listRuns(req.user!.orgId, req.params.id));
}));

const queueSchema = z.object({ message: z.string().max(200).optional(), planOnly: z.boolean().optional() });

workspacesRouter.post("/:id/runs", handle(async (req, res) => {
  res.status(201).json(await runs.queueRun(req.user!.orgId, req.params.id, parseBody(queueSchema, req.body ?? {})));
}));

const applySchema = z.object({ confirm: z.string(), comment: z.string().max(200).optional() });

workspacesRouter.post("/:id/runs/:runId/apply", handle(async (req, res) => {
  const body = parseBody(applySchema, req.body);
  res.status(202).json(await runs.applyRun(req.user!.orgId, req.params.id, req.params.runId, body));
}));

workspacesRouter.post("/:id/runs/:runId/discard", handle(async (req, res) => {
  const body = parseBody(z.object({ comment: z.string().max(200).optional() }), req.body ?? {});
  res.status(202).json(await runs.discardRun(req.user!.orgId, req.params.id, req.params.runId, body));
}));
