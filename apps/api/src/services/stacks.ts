import { Prisma } from "@prisma/client";
import { isGitHost, PROVIDER_LABELS, type GitHost } from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { Conflict, InvalidInput, NotFound } from "../lib/errors.js";
import { startJob } from "../lib/jobs/start.js";
import { TfInputValidationError, type TfArguments } from "../lib/tf/render.js";
import { TfcConnectionError, loadTfcConnection } from "../lib/tf/tfc-connection.js";
import {
  deliveryFor,
  getStack,
  listStacks,
  renderStack,
  resolveStackInputs,
  stackGitHosts,
  type StackManifest,
} from "../lib/stacks/index.js";

// ---------------------------------------------------------------------------
// Stack projects: a whole deploy setup rendered from a stack into the
// customer's app repository, landed as a pull request (lib/stacks and the
// stack job). Settings live on the project, in providerConfig, so every later
// job re-renders from the place the UI edits.
//
// The org's GitHub connection needs, on the destination repo: Contents, Pull
// requests and Workflows read/write. Workflows because a stack writes
// .github/workflows, and GitHub refuses that push without it.
// ---------------------------------------------------------------------------

export function listStackSummaries() {
  return listStacks().map((s) => ({
    slug: s.slug,
    name: s.name,
    description: s.description,
    template: s.template,
    target: s.target,
    runtime: s.runtime,
    deliveries: s.deliveries,
    gitHosts: stackGitHosts(s),
    inputSchema: s.inputSchema,
    example: s.example,
  }));
}

function stackOrNotFound(slug: string): StackManifest {
  const stack = getStack(slug);
  if (!stack) throw new NotFound("stack not found");
  return stack;
}

/**
 * A Terraform Cloud backend needs one of the org's TFC connections: the
 * workspace is created there, and tfc_organization is taken from it so the
 * generated cloud {} block names the same organization. Any other backend
 * clears the connection.
 */
async function withTfcConnection(
  orgId: string,
  args: TfArguments,
  connectionId: string | null | undefined
): Promise<{ args: TfArguments; tfcConnectionId: string | null }> {
  if (args.backend !== "tfc") return { args, tfcConnectionId: null };
  if (!connectionId) {
    throw new InvalidInput("a Terraform Cloud backend needs a Terraform Cloud connection: add one under Connections");
  }
  try {
    const cred = await loadTfcConnection(orgId, connectionId);
    return { args: { ...args, tfc_organization: cred.organization }, tfcConnectionId: connectionId };
  } catch (err) {
    if (err instanceof TfcConnectionError) throw new InvalidInput(err.message);
    throw err;
  }
}

/** Renders, turning a settings error into InvalidInput. */
function rendered<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof TfInputValidationError) throw new InvalidInput(err.message, { details: err.details });
    throw err;
  }
}

function deliveryMismatch(stack: StackManifest, host: GitHost, asked: unknown): InvalidInput {
  const fits = stack.deliveries.filter((x) => x.gitHost === host).map((x) => x.name);
  return new InvalidInput(
    fits.length
      ? `${String(asked)} does not run on ${PROVIDER_LABELS[host]}; use ${fits.join(" or ")}`
      : `${stack.name} has no delivery that runs on ${PROVIDER_LABELS[host]}`
  );
}

async function queueStackJob(projectId: string, settings: TfArguments) {
  const job = await prisma.tfJob.create({ data: { projectId, kind: "stack", argumentsJson: settings } });
  startJob(job.id);
  return job;
}

// -- preview ----------------------------------------------------------------------

export async function previewStack(
  orgId: string,
  slug: string,
  input: { arguments: TfArguments; tfcConnectionId?: string | null }
) {
  const stack = stackOrNotFound(slug);
  // Rendered with the connection's organization, as the project will be.
  const tfc = await withTfcConnection(orgId, input.arguments, input.tfcConnectionId);
  return { files: rendered(() => renderStack(stack, tfc.args)) };
}

// -- create -----------------------------------------------------------------------

export interface StackProjectInput {
  name: string;
  destRepo: string;
  destBranch: string;
  gitHost: GitHost;
  /** One of the org's connections to gitHost; default: the org's first. */
  connectionId?: string;
  /** Greenfield: create destRepo from the stack's app template first. */
  createRepo: boolean;
  /** The org's Terraform Cloud connection, for backend "tfc". */
  tfcConnectionId?: string | null;
  arguments: TfArguments;
}

export async function createStackProject(orgId: string, slug: string, input: StackProjectInput) {
  const stack = stackOrNotFound(slug);
  if (input.gitHost === "github" && input.destRepo.split("/").length !== 2) {
    throw new InvalidInput("a GitHub repository is owner/name");
  }
  // The delivery decides where CI runs, so it must match the repository's
  // host. Unnamed, it is the stack's delivery for that host.
  const delivery = deliveryFor(stack, input.gitHost, input.arguments.delivery);
  if (!delivery) throw deliveryMismatch(stack, input.gitHost, input.arguments.delivery);
  // The repository the delivery wires up is the project's own, so it is
  // taken from destRepo rather than asked for twice.
  const derived: TfArguments = { delivery: delivery.slug };
  if (delivery.gitHost === "gitlab") derived.gitlab_project = input.destRepo;
  else if (input.arguments.github_repository === undefined) derived.github_repository = input.destRepo.split("/").pop() ?? "";
  const tfc = await withTfcConnection(orgId, { ...input.arguments, ...derived }, input.tfcConnectionId);

  const connection = await prisma.providerConnection.findFirst({
    where: { orgId, provider: input.gitHost, ...(input.connectionId ? { id: input.connectionId } : {}) },
    select: { id: true },
  });
  if (!connection) throw new InvalidInput(`connect ${PROVIDER_LABELS[input.gitHost]} under Connections first`);

  // Render once now so bad settings fail here, not later inside a background
  // job. What gets stored is the settings with the stack's defaults filled
  // in: a default that changes later must not silently change an existing
  // project's servers on its next render.
  const settings = rendered(() => {
    const s = resolveStackInputs(stack, tfc.args);
    renderStack(stack, s);
    return s;
  });
  let project;
  try {
    project = await prisma.tfProject.create({
      data: {
        orgId,
        name: input.name,
        source: "stack",
        stackSlug: stack.slug,
        gitHost: input.gitHost,
        gitConnectionId: connection.id,
        createRepo: input.createRepo,
        tfcConnectionId: tfc.tfcConnectionId,
        destRepo: input.destRepo,
        destBranch: input.destBranch,
        providerConfig: settings,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new Conflict(`a project named ${input.name} already exists`);
    }
    throw err;
  }
  return { project, job: await queueStackJob(project.id, settings) };
}

// -- change settings ----------------------------------------------------------------

/**
 * Changing a stack project's settings re-renders it into a pull request, the
 * same as creating it. The input carries the complete settings, not a patch:
 * what the dashboard shows is what gets rendered. An unnamed TFC connection
 * keeps the one the project has.
 */
export async function updateStackSettings(
  orgId: string,
  projectId: string,
  input: { arguments: TfArguments; tfcConnectionId?: string | null }
) {
  const project = await prisma.tfProject.findFirst({ where: { id: projectId, orgId, source: "stack" } });
  if (!project) throw new NotFound("project not found");
  const stack = project.stackSlug ? getStack(project.stackSlug) : null;
  if (!stack) throw new NotFound("stack not found");
  // Every resource is named from `name`; changing it would make the next
  // apply replace the server, its volume and its tunnel.
  const current = project.providerConfig as TfArguments;
  if (input.arguments.name !== current.name) {
    throw new InvalidInput(`name is fixed after creation (it is ${String(current.name)}); every resource is named from it`);
  }
  const host = (isGitHost(project.gitHost) ? project.gitHost : "github") as GitHost;
  const delivery = deliveryFor(stack, host, input.arguments.delivery ?? current.delivery);
  if (!delivery) {
    throw new InvalidInput(
      `${String(input.arguments.delivery)} does not run on ${PROVIDER_LABELS[host]}, where this project's repository lives`
    );
  }
  const args: TfArguments = {
    ...input.arguments,
    delivery: delivery.slug,
    ...(host === "gitlab" ? { gitlab_project: project.destRepo } : {}),
  };
  const tfc = await withTfcConnection(
    orgId,
    args,
    input.tfcConnectionId === undefined ? project.tfcConnectionId : input.tfcConnectionId
  );
  const settings = rendered(() => {
    const s = resolveStackInputs(stack, tfc.args);
    renderStack(stack, s);
    return s;
  });
  const updated = await prisma.tfProject.update({
    where: { id: project.id },
    data: { providerConfig: settings, tfcConnectionId: tfc.tfcConnectionId },
  });
  return { project: updated, job: await queueStackJob(project.id, settings) };
}
