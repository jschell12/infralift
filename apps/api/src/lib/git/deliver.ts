import type { ChangeRequest, GitHostClient, HostFile } from "./hosts.js";

// ---------------------------------------------------------------------------
// Deliver files to a customer's repository as a change request.
//
// Every job that writes into a repository the customer works in (stacks,
// imports, adoptions) does the same thing, so it is written once here:
//
//   1. Reuse this project's open pull/merge request if there is one, so the
//      customer reviews one request per project, not one per click.
//   2. Otherwise branch from the base.
//   3. Commit the files as one commit.
//   4. Nothing changed: remove a branch this run created; leave an existing
//      request as it is.
//   5. Otherwise open the request (or keep the existing one).
//
// A branch this run created is deleted if anything fails before the request
// exists, so a failed run leaves nothing behind in the customer's repository.
// Nothing is ever pushed to the base branch.
// ---------------------------------------------------------------------------

export interface DeliveryRequest {
  repo: string;
  /** The branch the request targets (the repository's default branch). */
  base: string;
  /** True for a branch an earlier run of this same project created. */
  isMine: (branch: string) => boolean;
  /** Branch to create when there is no open request to reuse. */
  newBranch: string;
  /** Builds the files. It sees the open request they would land in, because a
   *  seed file the customer already edited there must not be overwritten. */
  files: (existing: ChangeRequest | null) => Promise<HostFile[]>;
  /** Directory the file names are relative to; "" = repository root. */
  workDir: string;
  message: string;
  title: string;
  /** Called only when a new request is opened, after files() has run. */
  body: () => string;
}

export type DeliveryResult =
  /** Nothing new to commit. `existing` is the open request already carrying the
   *  files, if there is one. */
  | { outcome: "unchanged"; existing: ChangeRequest | null; files: HostFile[] }
  /** Committed, and a request now carries it. */
  | { outcome: "opened" | "updated"; url: string; branch: string; commitSha: string | null; files: HostFile[] };

export async function deliverChangeRequest(
  client: GitHostClient,
  req: DeliveryRequest
): Promise<DeliveryResult> {
  const existing = await client.findOpenChangeRequest({ repo: req.repo, base: req.base, isMine: req.isMine });
  const files = await req.files(existing);
  const branch = existing?.branch ?? req.newBranch;
  let createdBranch = false;
  try {
    if (!existing) {
      await client.createBranch({ repo: req.repo, from: req.base, branch });
      createdBranch = true;
    }
    const commit = await client.commitFiles({
      repo: req.repo,
      branch,
      workDir: req.workDir,
      files,
      message: req.message,
    });
    if (commit.noop) {
      if (createdBranch) {
        await client.deleteBranch({ repo: req.repo, branch });
        createdBranch = false;
      }
      return { outcome: "unchanged", existing, files };
    }
    const url = existing
      ? existing.url
      : (await client.openChangeRequest({ repo: req.repo, head: branch, base: req.base, title: req.title, body: req.body() })).url;
    createdBranch = false; // the request owns the branch now
    return { outcome: existing ? "updated" : "opened", url, branch, commitSha: commit.commitSha, files };
  } catch (err) {
    if (createdBranch) await client.deleteBranch({ repo: req.repo, branch }).catch(() => {});
    throw err;
  }
}
