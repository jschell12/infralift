import { AppError } from "../errors.js";

// ---------------------------------------------------------------------------
// What a failed job says to the customer.
//
// A job's statusMessage is shown on the dashboard as it is stored. A runner
// that fails on purpose (run.fail("no GitHub connection ...")) writes its own
// sentence. A runner that throws used to store err.message whatever it was: a
// TypeError's "Cannot read properties of undefined", a Prisma error naming
// tables, or Terraform Cloud's raw response body. jobFailureMessage decides
// instead, and the caller logs the full error under the job id
// (JobRun.failSafely), so support can find it from what the customer sees.
//
// An error is shown as it is only when its class is written for a customer to
// read: every AppError (it is already an HTTP response's text), a timeout
// (names the host and the limit), and the domain errors listed in
// SHOWN_AS_WRITTEN, whose messages name the customer's own repository, stack
// or workspace. Terraform Cloud's client error carries the response body, so
// it is shown as its status only. Anything else gets the generic sentence.
//
// The domain errors are matched by class name rather than instanceof, so this
// module imports none of them: the job state machine depends on it, and the
// pipeline tests mock several of the modules those classes live in.
// ---------------------------------------------------------------------------

/** Error classes whose messages are written for the customer. */
const SHOWN_AS_WRITTEN = new Set([
  "HttpTimeoutError", // lib/http.ts
  "ProviderHttpError", // connectors/types.ts
  "TfCloudError", // lib/tf/workspace.ts
  "TfcConnectionError", // lib/tf/tfc-connection.ts
  "TfInputValidationError", // lib/tf/render.ts
  "StackFetchError", // lib/stacks/team.ts
  "AdoptInputError", // lib/import/adopt.ts
  "HclParseError", // lib/import/hcl.ts
  "DependencyGraphError", // lib/tf/extensions.ts
  "DependencyCycleError",
  "NotTemplatizableError",
  "UnsafeHostError",
  "WiringError",
]);

const className = (err: Error) => err.constructor?.name ?? err.name;

function terraformCloudMessage(status: number): string {
  if (status === 401 || status === 403) {
    return `Terraform Cloud refused the request (${status}). Check the Terraform Cloud connection under Connections.`;
  }
  if (status === 404) return `Terraform Cloud could not find what the job asked for (404). Check the project's workspace settings.`;
  if (status === 429) return `Terraform Cloud is rate limiting requests (429). Start the job again in a few minutes.`;
  if (status >= 500) return `Terraform Cloud failed to answer (${status}). Start the job again later.`;
  return `Terraform Cloud rejected the request (${status}).`;
}

/** The sentence stored on a job that failed with `err` at `stage`. */
export function jobFailureMessage(err: unknown, ctx: { jobId: string; stage: string }): string {
  if (!(err instanceof Error)) return genericMessage(ctx);
  const name = className(err);
  // lib/tf/tfc-client.ts: its message quotes the response body.
  if (name === "TfcClientError") return terraformCloudMessage(Number((err as { statusCode?: unknown }).statusCode));
  // connectors/types.ts: `expected` is written for the customer, the message is not.
  if (name === "CredentialFormatError") {
    return `The stored credential is not ${String((err as { expected?: unknown }).expected)}. Replace it under Connections, then start the job again.`;
  }
  if ((err instanceof AppError || SHOWN_AS_WRITTEN.has(name)) && err.message) return err.message;
  return genericMessage(ctx);
}

function genericMessage(ctx: { jobId: string; stage: string }): string {
  return `Something went wrong at the ${ctx.stage} step. Start the job again; if it fails the same way, contact support and quote job ${ctx.jobId}.`;
}
