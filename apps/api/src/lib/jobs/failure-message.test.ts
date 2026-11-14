import { describe, expect, it } from "vitest";
import { jobFailureMessage } from "./failure-message.js";
import { GitCommitError } from "../git/errors.js";
import { HttpTimeoutError } from "../http.js";
import { TfcClientError } from "../tf/tfc-client.js";
import { TfCloudError } from "../tf/workspace.js";
import { StackFetchError } from "../stacks/team.js";
import { CredentialFormatError } from "../../connectors/types.js";

const ctx = { jobId: "job_123", stage: "commit" };

describe("jobFailureMessage", () => {
  it("shows errors written for the customer as they are", () => {
    expect(jobFailureMessage(new GitCommitError("GitHub refused the commit to acme/app (422)"), ctx)).toBe(
      "GitHub refused the commit to acme/app (422)"
    );
    expect(jobFailureMessage(new HttpTimeoutError("api.github.com", 30_000), ctx)).toBe("api.github.com did not answer within 30s");
    expect(jobFailureMessage(new TfCloudError('workspace "prod" not found'), ctx)).toBe('workspace "prod" not found');
    expect(jobFailureMessage(new StackFetchError("main is not a branch, tag or commit in acme/stacks"), ctx)).toMatch(/acme\/stacks/);
  });

  it("never stores Terraform Cloud's response body, only its status", () => {
    // The body shape HCP Terraform answers a 422 with (JSON:API errors).
    const body = JSON.stringify({ errors: [{ status: "422", title: "invalid attribute", detail: "Name has already been taken" }] });
    const message = jobFailureMessage(new TfcClientError("POST", "/organizations/acme/workspaces", 422, body), ctx);
    expect(message).toBe("Terraform Cloud rejected the request (422).");
    expect(jobFailureMessage(new TfcClientError("GET", "/x", 401, "{}"), ctx)).toMatch(/Check the Terraform Cloud connection/);
    expect(jobFailureMessage(new TfcClientError("GET", "/x", 503, "<html>upstream trace</html>"), ctx)).not.toContain("trace");
  });

  it("names the credential expected, not the parser's complaint", () => {
    const err = new CredentialFormatError("Unexpected token } in JSON at position 41", "a service account key");
    expect(jobFailureMessage(err, ctx)).toBe(
      "The stored credential is not a service account key. Replace it under Connections, then start the job again."
    );
  });

  it.each([
    ["a TypeError", new TypeError("Cannot read properties of undefined (reading 'id')")],
    ["a plain Error from our own code", new Error("refusing to write a check for the path \"../x\"")],
    ["a database error", Object.assign(new Error("Invalid `prisma.tfJob.update()` invocation"), { code: "P2025" })],
    ["a thrown string", "boom"],
    ["an empty message", new TfCloudError("")],
  ])("replaces %s with the generic sentence naming the stage and the job", (_what, err) => {
    expect(jobFailureMessage(err, ctx)).toBe(
      "Something went wrong at the commit step. Start the job again; if it fails the same way, contact support and quote job job_123."
    );
  });
});
