import { Upstream } from "../errors.js";

/** A git host (GitHub, GitLab) refused or failed a request. The message names
 *  the operation, repository and status, never a token. A request that hits
 *  one answers 502 with that message. */
export class GitCommitError extends Upstream {
  constructor(message: string) {
    super(message);
  }
}
