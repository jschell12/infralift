// ---------------------------------------------------------------------------
// Starting the infralift API from source against the e2e stack.
//
// global-setup.ts starts the one the adopt tests share. providers.e2e.test.ts
// starts one per provider, because the unmanaged view allows an org ten
// provider reads per ten minutes (services/unmanaged.ts, in-process) and the
// suite reads more accounts than that; a fresh process has a fresh allowance.
//
// The API gets a built environment, not this process's: PATH and HOME plus
// the stack's values, so a real GH_TOKEN, AWS profile or DATABASE_URL in the
// shell that ran `make e2e` can never reach it.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { STACK } from "./env.js";

const apiDir = new URL("../..", import.meta.url).pathname;

/** Every provider endpoint pointed at the stack (lib/endpoints.ts). */
export function stackEndpoints(): Record<string, string> {
  const fakes = STACK.providerFakes;
  const m = STACK.mocks;
  return {
    INFRALIFT_ENDPOINT_AWS: STACK.moto,
    INFRALIFT_ENDPOINT_GITHUB_API: STACK.githubFake,
    INFRALIFT_ENDPOINT_CLOUDFLARE_API: STACK.cloudflare,
    INFRALIFT_ENDPOINT_DIGITALOCEAN_API: `${m.digitalocean}/v2`,
    INFRALIFT_ENDPOINT_RENDER_API: m.render,
    INFRALIFT_ENDPOINT_VERCEL_API: m.vercel,
    INFRALIFT_ENDPOINT_HEROKU_API: m.heroku,
    INFRALIFT_ENDPOINT_NETLIFY_API: m.netlify,
    INFRALIFT_ENDPOINT_FLY_MACHINES_API: `${m.flyioMachines}/v1`,
    INFRALIFT_ENDPOINT_FLY_API: `${fakes}/fly`,
    INFRALIFT_ENDPOINT_RAILWAY_API: `${fakes}/railway/graphql`,
    INFRALIFT_ENDPOINT_AZURE_LOGIN: `${fakes}/azure`,
    INFRALIFT_ENDPOINT_AZURE_MANAGEMENT: m.azure,
    INFRALIFT_ENDPOINT_GOOGLE_OAUTH_TOKEN: `${fakes}/google/token`,
    INFRALIFT_ENDPOINT_GCP_RUN: m.google,
    INFRALIFT_ENDPOINT_GCP_COMPUTE: m.google,
    INFRALIFT_ENDPOINT_GCP_SQLADMIN: m.google,
    INFRALIFT_ENDPOINT_GCP_STORAGE: m.google,
    INFRALIFT_ENDPOINT_GCP_CLOUDFUNCTIONS: m.google,
    INFRALIFT_ENDPOINT_FIREBASE_HOSTING: m.google,
    INFRALIFT_ENDPOINT_FIRESTORE: m.google,
  };
}

function apiEnv(port: number): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "development",
    PORT: String(port),
    DATABASE_URL: STACK.databaseUrl,
    TOKEN_ENCRYPTION_KEY: STACK.tokenEncryptionKey,
    // infralift's own AWS principal: moto's test keys, and an account id
    // that only appears in the trust policy text.
    INFRALIFT_AWS_ACCOUNT_ID: "000000000000",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    AWS_REGION: "us-east-1",
    AWS_EC2_METADATA_DISABLED: "true",
    ...stackEndpoints(),
  };
}

export interface RunningApi {
  url: string;
  log: string;
  stop(): Promise<void>;
}

async function waitForHealth(child: ChildProcess, url: string, log: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the API exited (${child.exitCode}); see ${log}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the API did not answer ${url} within ${timeoutMs / 1000}s; see ${log}`);
}

/** The API from source on `port`, logging to e2e/<logName>. */
export async function startApi(port: number, logName: string): Promise<RunningApi> {
  const log = join(apiDir, "e2e", logName);
  const out = createWriteStream(log);
  const child = spawn(join(apiDir, "node_modules/.bin/tsx"), ["src/server.ts"], { cwd: apiDir, env: apiEnv(port), stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.pipe(out);
  child.stderr!.pipe(out);
  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(child, `${url}/health`, log, 60_000);
  return {
    url,
    log,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    },
  };
}
