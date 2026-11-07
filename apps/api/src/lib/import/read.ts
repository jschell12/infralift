import type { GitHostClient } from "../git/hosts.js";
import { isScanFile, type RepoFile } from "./scan.js";

// Reads the Terraform-related files of a repository for a scan. Bounded, so a
// monorepo cannot turn one click into thousands of API calls.

export const READ_LIMITS = { maxFiles: 400, maxBytes: 512 * 1024, concurrency: 8 };

export interface RepoRead {
  ref: string;
  files: RepoFile[];
  /** What was left out and why, so a partial scan never reads as a full one. */
  skipped: string[];
}

export async function readRepoForScan(
  client: GitHostClient,
  repo: string,
  ref?: string
): Promise<RepoRead> {
  const branch = ref || (await client.defaultBranch(repo));
  const listing = await client.listFiles({ repo, ref: branch });
  const skipped: string[] = [];
  if (listing.truncated) {
    skipped.push("The repository is too large to list in one call; some directories were not scanned.");
  }
  let wanted = listing.paths.filter(isScanFile).sort();
  if (wanted.length > READ_LIMITS.maxFiles) {
    skipped.push(`${wanted.length - READ_LIMITS.maxFiles} Terraform files past the first ${READ_LIMITS.maxFiles} were not read.`);
    wanted = wanted.slice(0, READ_LIMITS.maxFiles);
  }
  const files: RepoFile[] = [];
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const path = wanted[next++];
      const content = await client.readFile({ repo, path, ref: branch });
      if (content === null) continue;
      if (content.length > READ_LIMITS.maxBytes) {
        skipped.push(`${path} is over ${READ_LIMITS.maxBytes / 1024} KB and was not read.`);
        continue;
      }
      files.push({ path, content });
    }
  };
  await Promise.all(Array.from({ length: READ_LIMITS.concurrency }, worker));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ref: branch, files, skipped };
}
