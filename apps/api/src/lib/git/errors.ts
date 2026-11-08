/** A git host (GitHub, GitLab) refused or failed a request. The message names
 *  the operation, repository and status, never a token. */
export class GitCommitError extends Error {}
