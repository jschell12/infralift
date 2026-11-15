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
//
// customerSafeMessage is the shared half: the sentence for an error written
// for a customer, or null. A failed assessment's stored error uses it too
// (assessmentFailureMessage in services/assessments.ts), with its own generic
// sentence.
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

function terraformCloudMessage(status: number, again: string): string {
  if (status === 401 || status === 403) {
    return `Terraform Cloud refused the request (${status}). Check the Terraform Cloud connection under Connections.`;
  }
  if (status === 404) return `Terraform Cloud could not find what the job asked for (404). Check the project's workspace settings.`;
  if (status === 429) return `Terraform Cloud is rate limiting requests (429). ${capitalize(again)} in a few minutes.`;
  if (status >= 500) return `Terraform Cloud failed to answer (${status}). ${capitalize(again)} later.`;
  return `Terraform Cloud rejected the request (${status}).`;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The sentence for `err` when its class is written for the customer, or null
 * when it is not and the caller should store its own generic sentence.
 * `again` is what to do once the cause is fixed, lowercase and without a full
 * stop: "start the job again", "run the assessment again".
 */
export function customerSafeMessage(err: unknown, again: string): string | null {
  if (!(err instanceof Error)) return null;
  const name = className(err);
  // lib/tf/tfc-client.ts: its message quotes the response body.
  if (name === "TfcClientError") return terraformCloudMessage(Number((err as { statusCode?: unknown }).statusCode), again);
  // connectors/types.ts: `expected` is written for the customer, the message is not.
  if (name === "CredentialFormatError") {
    return `The stored credential is not ${String((err as { expected?: unknown }).expected)}. Replace it under Connections, then ${again}.`;
  }
  if ((err instanceof AppError || SHOWN_AS_WRITTEN.has(name)) && err.message) return err.message;
  return null;
}

/** The sentence stored on a job that failed with `err` at `stage`. */
export function jobFailureMessage(err: unknown, ctx: { jobId: string; stage: string }): string {
  return customerSafeMessage(err, "start the job again") ?? genericMessage(ctx);
}

function genericMessage(ctx: { jobId: string; stage: string }): string {
  return `Something went wrong at the ${ctx.stage} step. Start the job again; if it fails the same way, contact support and quote job ${ctx.jobId}.`;
}
