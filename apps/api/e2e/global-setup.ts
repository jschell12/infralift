// ---------------------------------------------------------------------------
// Starts what the e2e suite needs beyond docker-compose.e2e.yml: migrates the
// throwaway database, starts the GitHub fake and the provider fake (GraphQL
// and OAuth token endpoints), and starts the API from source with every
// provider endpoint pointed at the stack (harness/api-process.ts).
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { startGithubFake, type RunningFake } from "./github-fake/server.js";
import { startApi, type RunningApi } from "./harness/api-process.js";
import { STACK } from "./harness/env.js";
import { startProviderFakes, type RunningProviderFakes } from "./provider-fakes/server.js";

const apiDir = new URL("..", import.meta.url).pathname;
let api: RunningApi | null = null;
let fake: RunningFake | null = null;
let providerFakes: RunningProviderFakes | null = null;

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
  providerFakes = await startProviderFakes(STACK.providerFakesPort);
  api = await startApi(STACK.apiPort, ".api.log");
}

export async function teardown(): Promise<void> {
  await api?.stop();
  await fake?.close();
  await providerFakes?.close();
}
