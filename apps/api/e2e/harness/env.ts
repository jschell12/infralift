// Where the e2e stack listens. Fixed ports, bound to 127.0.0.1, matching
// docker-compose.e2e.yml; the fake and the API are started by global-setup.ts.

export const STACK = {
  repoRoot: new URL("../../../../", import.meta.url).pathname,
  composeFile: new URL("../../../../docker-compose.e2e.yml", import.meta.url).pathname,
  databaseUrl: "postgresql://postgres:postgres@127.0.0.1:55432/infralift_e2e",
  moto: "http://127.0.0.1:55000",
  cloudflare: "http://127.0.0.1:54010",
  githubFakePort: 54020,
  githubFake: "http://127.0.0.1:54020",
  apiPort: 54400,
  api: "http://127.0.0.1:54400",
  /** A fixed key for the throwaway database. Not a secret: it encrypts
   *  only the fake tokens below. */
  tokenEncryptionKey: "e2e0".repeat(16),
  /** Tokens the fakes accept. Not credentials of anything real. */
  githubToken: "e2e-github-token",
  cloudflareToken: "e2e-cloudflare-token",
  /** moto's default account, and a role in it for infralift to assume. */
  awsAccount: "123456789012",
  awsRoleArn: "arn:aws:iam::123456789012:role/infralift-readonly",
} as const;
