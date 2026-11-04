// Renders every stack with its example inputs, once per state backend, and
// runs the tools a customer will run on the output. A stack that renders but
// does not validate is broken output, and only running the tools finds that.
//
//   pnpm --filter @infralift/api validate:stacks
//
// Needs tofu and terraform on PATH; shellcheck is used when present.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listStacks, renderStack } from "../src/lib/stacks/index.js";

function run(cwd: string, cmd: string, args: string[]) {
  try {
    execFileSync(cmd, args, { cwd, stdio: "pipe" });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `${cmd} ${args.join(" ")} failed in ${cwd}:\n${e.stdout ?? ""}${e.stderr ?? ""}`
    );
  }
}

const has = (cmd: string) => {
  try {
    execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};

let failures = 0;
for (const stack of listStacks()) {
  for (const backend of ["r2", "tfc"] as const) {
    const label = `${stack.slug} [${backend}]`;
    const out = mkdtempSync(join(tmpdir(), `stack-${stack.slug}-${backend}-`));
    try {
      const inputs = {
        ...stack.example,
        backend,
        ...(backend === "tfc" ? { tfc_organization: "example-org" } : {}),
      };
      for (const f of renderStack(stack, inputs)) {
        const full = join(out, f.path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, f.content);
        if (f.mode === "100755") chmodSync(full, 0o755);
      }
      const infra = join(out, "deploy/infra");
      run(out, "tofu", ["fmt", "-check", "-recursive", "deploy"]);
      run(infra, "tofu", ["init", "-backend=false", "-input=false"]);
      run(infra, "tofu", ["validate"]);
      if (backend === "r2") {
        const boot = join(out, "deploy/bootstrap");
        run(boot, "tofu", ["init", "-backend=false", "-input=false"]);
        run(boot, "tofu", ["validate"]);
      } else {
        // A TFC workspace runs the root module with terraform, not tofu.
        run(infra, "terraform", ["init", "-backend=false", "-input=false"]);
        run(infra, "terraform", ["validate"]);
      }
      const generated = join(infra, "generated");
      run(generated, "terraform", ["init", "-backend=false", "-input=false"]);
      run(generated, "terraform", ["validate"]);
      if (has("shellcheck")) {
        run(out, "sh", ["-c", "shellcheck deploy/box/bin/*.sh deploy/box/*.sh"]);
      }
      console.log(`ok   ${label}`);
    } catch (err) {
      failures++;
      console.error(`FAIL ${label}\n${(err as Error).message}`);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
}
process.exit(failures ? 1 : 0);
