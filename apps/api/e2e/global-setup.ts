// ---------------------------------------------------------------------------
// Starts what the e2e suite needs beyond docker-compose.e2e.yml: migrates the
// throwaway database, starts the GitHub fake, and starts the API from source
// with every provider endpoint pointed at the stack (lib/endpoints.ts).
//
// The API gets a built environment, not this process's: PATH and HOME plus
// the stack's values, so a real GH_TOKEN, AWS profile or DATABASE_URL in the
// shell that ran `make e2e` can never reach it.
// ---------------------------------------------------------------------------

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { startGithubFake, type RunningFake } from "./github-fake/server.js";
import { STACK } from "./harness/env.js";

const apiDir = new URL("..", import.meta.url).pathname;
let apiProcess: ChildProcess | null = null;
let fake: RunningFake | null = null;

export const API_LOG = join(apiDir, "e2e", ".api.log");

function apiEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "development",
    PORT: String(STACK.apiPort),
    DATABASE_URL: STACK.databaseUrl,
    TOKEN_ENCRYPTION_KEY: STACK.tokenEncryptionKey,
    // infralift's own AWS principal: moto's test keys, and an account id
    // that only appears in the trust policy text.
    INFRALIFT_AWS_ACCOUNT_ID: "000000000000",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    AWS_REGION: "us-east-1",
    AWS_EC2_METADATA_DISABLED: "true",
    INFRALIFT_ENDPOINT_AWS: STACK.moto,
    INFRALIFT_ENDPOINT_GITHUB_API: STACK.githubFake,
    INFRALIFT_ENDPOINT_CLOUDFLARE_API: STACK.cloudflare,
  };
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (apiProcess?.exitCode !== null && apiProcess?.exitCode !== undefined) throw new Error(`the API exited (${apiProcess.exitCode}); see ${API_LOG}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the API did not answer ${url} within ${timeoutMs / 1000}s; see ${API_LOG}`);
}

export async function setup(): Promise<void> {
  const migrate = spawnSync(join(apiDir, "node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: apiDir,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: STACK.databaseUrl },
    encoding: "utf8",
  });
  if (migrate.status !== 0) {
    throw new Error(`prisma migrate deploy failed; is the stack up? (docker compose -f docker-compose.e2e.yml up -d --wait)\n${migrate.stdout}${migrate.stderr}`);
  }

  fake = await startGithubFake(STACK.githubFakePort);

  const log = createWriteStream(API_LOG);
  apiProcess = spawn(join(apiDir, "node_modules/.bin/tsx"), ["src/server.ts"], { cwd: apiDir, env: apiEnv(), stdio: ["ignore", "pipe", "pipe"] });
  apiProcess.stdout!.pipe(log);
  apiProcess.stderr!.pipe(log);
  await waitForHealth(`${STACK.api}/health`, 60_000);
}

export async function teardown(): Promise<void> {
  if (apiProcess && apiProcess.exitCode === null) {
    apiProcess.kill("SIGTERM");
    await new Promise((r) => apiProcess!.once("exit", r));
  }
  await fake?.close();
}
