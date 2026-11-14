// Where this checkout's e2e stack listens: ports and the compose project are
// derived from the checkout's path (harness/ports.ts), so concurrent runs in
// two worktrees do not collide. Bound to 127.0.0.1; docker-compose.e2e.yml
// reads the same numbers from scripts/e2e.sh. The fakes and the API are
// started by global-setup.ts.

import { REPO_ROOT, stackLayout } from "./ports.js";

const layout = stackLayout(REPO_ROOT);
const p = layout.ports;
const local = (port: number) => `http://127.0.0.1:${port}`;

export const STACK = {
  repoRoot: REPO_ROOT,
  composeFile: new URL("../../../../docker-compose.e2e.yml", import.meta.url).pathname,
  /** The compose project (-p), so `run` and `down` touch only this checkout's stack. */
  composeProject: layout.project,
  databaseUrl: `postgresql://postgres:postgres@127.0.0.1:${p.postgres}/infralift_e2e`,
  moto: local(p.moto),
  cloudflare: local(p.cloudflare),
  /** Prism, one per description (docker-compose.e2e.yml, profile "mocks"). */
  mocks: {
    digitalocean: local(p.digitalocean),
    render: local(p.render),
    vercel: local(p.vercel),
    heroku: local(p.heroku),
    netlify: local(p.netlify),
    flyioMachines: local(p.flyioMachines),
    azure: local(p.azure),
    google: local(p.google),
  },
  /** GraphQL and OAuth token fakes (provider-fakes/server.ts). */
  providerFakesPort: p.providerFakes,
  providerFakes: local(p.providerFakes),
  githubFakePort: p.githubFake,
  githubFake: local(p.githubFake),
  apiPort: p.api,
  api: local(p.api),
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
