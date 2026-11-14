import { spawn } from "node:child_process";
import { STACK } from "./env.js";

export interface StepResult {
  code: number;
  output: string;
}

/** Runs a shell script in the stack's OpenTofu container, with `dir` (a host
 *  directory holding a checkout) mounted at /work and `cwd` relative to it.
 *  bash -eo pipefail, as GitHub Actions runs a `run:` step. */
export function runInTofu(opts: { dir: string; cwd?: string; script: string; env?: Record<string, string> }): Promise<StepResult> {
  const args = ["compose", "-f", STACK.composeFile, "--profile", "tools", "run", "--rm", "-T", "-v", `${opts.dir}:/work`, "-w", `/work/${opts.cwd ?? ""}`];
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
  args.push("tofu", "bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", opts.script);
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}
