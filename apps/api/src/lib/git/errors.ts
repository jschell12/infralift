import { Upstream } from "../errors.js";

/** A file was bigger than the caller said it would read. Not a host failure:
 *  the caller decides what it means (lib/stacks/team.ts records it). */
export class GitFileTooLarge extends Error {
  constructor(readonly path: string, readonly maxBytes: number) {
    super(`${path} is over ${maxBytes} bytes`);
  }
}

/** A git host (GitHub, GitLab) refused or failed a request. The message names
 *  the operation, repository and status, never a token. A request that hits
 *  one answers 502 with that message. */
export class GitCommitError extends Upstream {
  /** The git host's HTTP status (not this error's own 502), when the request got one. Every site that
   *  has one formats it as "(NNN)" in the message (github.ts, hosts.ts), so
   *  it is read from there rather than threaded through ~30 throw sites. */
  readonly hostStatus: number | null;

  /** GitHub's primary or secondary rate limit, which can answer 403: a
   *  back-off, never a refused credential. */
  readonly rateLimited: boolean;

  constructor(message: string, status?: number, opts: { rateLimited?: boolean } = {}) {
    super(message);
    this.rateLimited = opts.rateLimited ?? false;
    this.hostStatus = status ?? (Number(message.match(/\((\d{3})\)/)?.[1] ?? NaN) || null);
  }
}
