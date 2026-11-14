import { AppError } from "../errors.js";
import { HttpTimeoutError } from "../http.js";
import { CredentialFormatError, ProviderHttpError } from "../../connectors/types.js";
import { TfCloudError } from "../tf/workspace.js";
import { TfcClientError } from "../tf/tfc-client.js";
import { TfcConnectionError } from "../tf/tfc-connection.js";
import { TfInputValidationError } from "../tf/render.js";
import { StackFetchError } from "../stacks/team.js";
import { AdoptInputError } from "../import/adopt.js";
import { HclParseError } from "../import/hcl.js";
import { DependencyGraphError, NotTemplatizableError, UnsafeHostError, WiringError } from "../tf/extensions.js";

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
// ---------------------------------------------------------------------------

/** Error classes whose messages are written for the customer. */
const SHOWN_AS_WRITTEN: (abstract new (...args: never[]) => Error)[] = [
  AppError,
  HttpTimeoutError,
  ProviderHttpError,
  TfCloudError,
  TfcConnectionError,
  TfInputValidationError,
  StackFetchError,
  AdoptInputError,
  HclParseError,
  DependencyGraphError,
  NotTemplatizableError,
  UnsafeHostError,
  WiringError,
];

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
  if (err instanceof TfcClientError) return terraformCloudMessage(err.statusCode);
  if (err instanceof CredentialFormatError) {
    return `The stored credential is not ${err.expected}. Replace it under Connections, then start the job again.`;
  }
  if (err instanceof Error && SHOWN_AS_WRITTEN.some((cls) => err instanceof cls) && err.message) return err.message;
  return `Something went wrong at the ${ctx.stage} step. Start the job again; if it fails the same way, contact support and quote job ${ctx.jobId}.`;
}
