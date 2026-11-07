import type { RootModule } from "./scan.js";

// ---------------------------------------------------------------------------
// The import check: a GitHub Actions workflow infralift adds to the customer's
// repository for one root module. It runs a read-only plan against the state
// that module already has, in the customer's own CI with the customer's own
// secrets, and passes only when the plan changes nothing.
//
// Read-only is literal: `plan -lock=false` neither writes state nor takes the
// lock, so it cannot block or race the customer's own pipeline, and nothing is
// applied. That is what makes an import a zero-downtime operation: infralift
// takes over a module only once the plan proves its code already describes
// what is running.
// ---------------------------------------------------------------------------

export interface CheckFile {
  path: string;
  content: string;
}

/** Secret names may not start with GITHUB_ and may only hold [A-Za-z0-9_]. */
export function secretNameFor(env: string): string {
  const name = env.replace(/[^A-Za-z0-9_]/g, "_");
  return name.startsWith("GITHUB_") ? `INFRALIFT_${name}` : name;
}

export function checkSlug(path: string): string {
  return path ? path.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() : "root";
}

export function checkWorkflowPath(path: string): string {
  return `.github/workflows/infralift-import-${checkSlug(path)}.yml`;
}

/** Every env var the check sets from a secret: backend and provider
 *  credentials, then TF_VAR_ for each variable the repository leaves unset. */
export function checkEnv(root: RootModule): { env: string; secret: string }[] {
  const names = [...root.credentials, ...root.requiredVariables.map((v) => `TF_VAR_${v}`)];
  return names.map((env) => ({ env, secret: secretNameFor(env) }));
}

const yamlString = (s: string) => JSON.stringify(s);

export function renderImportCheck(
  root: RootModule,
  opts: { backendConfigFile?: string | null } = {}
): CheckFile {
  const file = checkWorkflowPath(root.path);
  const dir = root.path || ".";
  const tf = root.tool;
  const env = checkEnv(root);
  const label = root.path || "repository root";
  for (const p of [root.path, opts.backendConfigFile ?? ""]) {
    if (!isSafePath(p)) throw new Error(`refusing to write a check for the path ${JSON.stringify(p)}`);
  }
  // Repository paths reach the shell only through env vars, never spliced into
  // a script, so a directory name cannot become a command in the customer's CI.
  const backendConfig = opts.backendConfigFile ? ' -backend-config="$BACKEND_CONFIG"' : "";
  const setup =
    tf === "tofu"
      ? ["      - uses: opentofu/setup-opentofu@v1", "        with:", "          tofu_wrapper: false"]
      : ["      - uses: hashicorp/setup-terraform@v3", "        with:", "          terraform_wrapper: false"];

  const lines = [
    "# Managed by infralift. Read-only: plans against this module's existing state",
    "# and applies nothing. It passes when the plan changes nothing, which is when",
    "# infralift can take the module over without touching what is running.",
    `name: ${yamlString(`infralift import check: ${label}`)}`,
    "",
    "on:",
    "  pull_request:",
    "    paths:",
    `      - ${yamlString(root.path ? `${root.path}/**` : "**/*.tf")}`,
    `      - ${yamlString(file)}`,
    "  workflow_dispatch: {}",
    "",
    "permissions:",
    "  contents: read",
    "",
    "concurrency:",
    `  group: infralift-import-${checkSlug(root.path)}-\${{ github.ref }}`,
    "  cancel-in-progress: true",
    "",
    "jobs:",
    "  plan:",
    "    name: Plan changes nothing",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 30",
    "    defaults:",
    "      run:",
    `        working-directory: ${yamlString(dir)}`,
    "    env:",
    '      TF_IN_AUTOMATION: "1"',
    '      TF_INPUT: "0"',
    `      MODULE_LABEL: ${yamlString(label)}`,
    ...(opts.backendConfigFile
      ? [`      BACKEND_CONFIG: ${yamlString(relativeTo(root.path, opts.backendConfigFile))}`]
      : []),
    ...env.map((e) => `      ${e.env}: \${{ secrets.${e.secret} }}`),
    "    steps:",
    "      - uses: actions/checkout@v4",
    ...setup,
    "",
    "      - name: Check the secrets are set",
    "        env:",
    `          REQUIRED: ${yamlString(env.map((e) => `${e.env}=${e.secret}`).join(" "))}`,
    "        run: |",
    '          missing=""',
    "          for pair in $REQUIRED; do",
    '            if [ -z "$(printenv "${pair%%=*}")" ]; then missing="$missing ${pair#*=}"; fi',
    "          done",
    '          if [ -n "$missing" ]; then',
    '            echo "::error::Add these repository secrets, then re-run:$missing"',
    "            exit 1",
    "          fi",
    "",
    "      - name: Init",
    `        run: ${tf} init -input=false${backendConfig}`,
    "",
    "      - name: Plan (read-only, no lock)",
    "        run: |",
    "          set +e",
    `          ${tf} plan -input=false -lock=false -no-color -detailed-exitcode -out=infralift-import.tfplan > plan.log 2>&1`,
    "          code=$?",
    "          set -e",
    '          if [ "$code" -eq 1 ]; then',
    "            tail -n 80 plan.log",
    '            echo "::error::The plan failed before it could compare anything. Nothing was changed."',
    "            exit 1",
    "          fi",
    `          ${tf} show -json infralift-import.tfplan > plan.json`,
    "          changing='[.resource_changes[]? | select(.change.actions != [\"no-op\"] and .change.actions != [\"read\"])]'",
    '          changes=$(jq "$changing | length" plan.json)',
    "          total=$(jq '[.resource_changes[]? | select(.mode == \"managed\")] | length' plan.json)",
    "          drift=$(jq '[.resource_drift[]?] | length' plan.json)",
    "          {",
    '            echo "## infralift import check: $MODULE_LABEL"',
    '            echo ""',
    '            if [ "$changes" -eq 0 ]; then',
    '              echo "No changes. All $total resources match the code, so infralift can take this module over without touching anything."',
    "            else",
    '              echo "$changes of $total resources would change. infralift will not take this module over until this is 0."',
    '              echo ""',
    '              echo "| Action | Resource |"',
    '              echo "| --- | --- |"',
    '              jq -r "$changing | .[] | \\"| \\(.change.actions | join(\\", \\")) | \\`\\(.address)\\` |\\"" plan.json',
    "            fi",
    '            if [ "$drift" -gt 0 ]; then',
    '              echo ""',
    '              echo "$drift resource(s) were changed outside Terraform since the last apply."',
    "            fi",
    '          } >> "$GITHUB_STEP_SUMMARY"',
    '          echo "$changes of $total resources would change"',
    '          [ "$changes" -eq 0 ]',
    "",
  ];
  return { path: file, content: lines.join("\n") };
}

/** Paths the check will name: letters, digits, dot, dash, underscore and
 *  slash. Anything else (quotes, $, backticks, `${{`) is refused rather than
 *  escaped, because it would pass through YAML, the Actions expression
 *  engine and a shell, each with its own quoting. */
export function isSafePath(path: string): boolean {
  return /^[A-Za-z0-9._/-]*$/.test(path) && !path.split("/").includes("..");
}

/** A repository path as seen from the module's directory. */
function relativeTo(dir: string, path: string): string {
  if (!dir) return path;
  return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path;
}
