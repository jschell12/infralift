import { spawn } from "node:child_process";
import { STACK } from "./env.js";

export interface StepResult {
  code: number;
  output: string;
}

/** The host user, so files the container writes into the mounted checkout
 *  (generated.tf, .terraform/) belong to whoever runs the suite. As root,
 *  Linux leaves them root-owned and the suite cannot rewrite or delete them;
 *  Docker Desktop on macOS remaps ownership and hides the problem. */
function hostUser(): string[] {
  return typeof process.getuid === "function" && typeof process.getgid === "function"
    ? ["--user", `${process.getuid()}:${process.getgid()}`]
    : [];
}

/** Runs a shell script in the stack's OpenTofu container, with `dir` (a host
 *  directory holding a checkout) mounted at /work and `cwd` relative to it,
 *  as the host user (HOME is /tmp, which any user can write).
 *  bash -eo pipefail, as GitHub Actions runs a `run:` step. */
export function runInTofu(opts: { dir: string; cwd?: string; script: string; env?: Record<string, string> }): Promise<StepResult> {
  const args = ["compose", "-f", STACK.composeFile, "--profile", "tools", "run", "--rm", "-T", ...hostUser(), "-e", "HOME=/tmp", "-v", `${opts.dir}:/work`, "-w", `/work/${opts.cwd ?? ""}`];
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
