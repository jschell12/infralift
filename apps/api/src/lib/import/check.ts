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

/** The check job's name, which GitHub uses as the check run's name. */
export const CHECK_JOB_NAME = "Plan changes nothing";

/** Subject of the commit the check makes when it generates resource code.
 *  GitHub does not run workflows for a commit pushed with the job's own
 *  token, so the result reader looks past this commit to the run that made
 *  it (lib/import/result.ts). */
export const GENERATED_COMMIT_SUBJECT = "infralift: generated code for imported resources";

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

/** Env var names the check will write: Terraform's own identifier rule. A
 *  name reaches YAML keys, the Actions expression engine and printenv, so
 *  anything else is refused rather than escaped. */
export function isSafeEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name);
}

/**
 * A cloud whose credentials can come from stored keys or from OIDC (CI signs
 * in as a role; no key is stored anywhere). The group is satisfied by either:
 * every `keys` secret set, or every `oidcVars` repository variable set.
 * Repository variables, not secrets: a role ARN or provider name is not a
 * credential.
 */
export interface CredentialGroup {
  cloud: "aws" | "gcp" | "azure";
  label: string;
  keys: string[];
  oidcVars: string[];
}

const GROUPS: CredentialGroup[] = [
  {
    cloud: "aws",
    label: "AWS",
    keys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
    oidcVars: ["INFRALIFT_AWS_ROLE_ARN"],
  },
  {
    cloud: "gcp",
    label: "Google Cloud",
    keys: ["GOOGLE_CREDENTIALS"],
    oidcVars: ["INFRALIFT_GCP_WORKLOAD_IDENTITY_PROVIDER", "INFRALIFT_GCP_SERVICE_ACCOUNT"],
  },
  {
    cloud: "azure",
    label: "Azure",
    keys: ["ARM_CLIENT_ID", "ARM_CLIENT_SECRET", "ARM_TENANT_ID", "ARM_SUBSCRIPTION_ID"],
    oidcVars: ["INFRALIFT_AZURE_CLIENT_ID", "INFRALIFT_AZURE_TENANT_ID", "INFRALIFT_AZURE_SUBSCRIPTION_ID"],
  },
];

/** The clouds this module signs in to, in a fixed order. */
export function checkGroups(root: RootModule): CredentialGroup[] {
  return GROUPS.filter((g) => g.keys.some((k) => root.credentials.includes(k)));
}

/** Every env var the check sets from a secret: credentials, then TF_VAR_ for
 *  each variable the repository leaves unset. Throws on a name it will not
 *  write (the scan blocks such modules first). */
export function checkEnv(root: RootModule): { env: string; secret: string }[] {
  const names = [...root.credentials, ...root.requiredVariables.map((v) => `TF_VAR_${v}`)];
  for (const n of names) {
    if (!isSafeEnvName(n)) throw new Error(`refusing to write a check with the env name ${JSON.stringify(n)}`);
  }
  return names.map((env) => ({ env, secret: secretNameFor(env) }));
}

/** Plain-language list of what the customer sets, for the PR body and UI. */
export function checkSetupLines(root: RootModule): string[] {
  const env = checkEnv(root);
  const groups = checkGroups(root);
  const grouped = new Set(groups.flatMap((g) => g.keys));
  const lines = groups.map(
    (g) =>
      `${g.label}: secrets ${g.keys.map((k) => `\`${secretNameFor(k)}\``).join(", ")}, or for OIDC with no stored key, repository variables ${g.oidcVars.map((v) => `\`${v}\``).join(", ")}`
  );
  for (const e of env) if (!grouped.has(e.env)) lines.push(`\`${e.secret}\``);
  return lines;
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
  const groups = checkGroups(root);
  const gen = root.generateConfig === true;
  const has = (c: CredentialGroup["cloud"]) => groups.some((g) => g.cloud === c);
  const label = root.path || "repository root";
  for (const p of [root.path, opts.backendConfigFile ?? ""]) {
    if (!isSafePath(p)) throw new Error(`refusing to write a check for the path ${JSON.stringify(p)}`);
  }
  // Repository paths reach the shell only through env vars, never spliced into
  // a script, so a directory name cannot become a command in the customer's CI.
  // R2 keys go to init alone as backend config: as AWS_* env vars they would
  // also be picked up by the aws provider, which needs AWS's keys, not R2's.
  const r2 = root.backend.kind === "r2";
  const backendConfig =
    (opts.backendConfigFile ? ' -backend-config="$BACKEND_CONFIG"' : "") +
    (r2 ? ' -backend-config="access_key=$R2_ACCESS_KEY_ID" -backend-config="secret_key=$R2_SECRET_ACCESS_KEY"' : "");
  const setup =
    tf === "tofu"
      ? ["      - uses: opentofu/setup-opentofu@v1", "        with:", "          tofu_wrapper: false"]
      : ["      - uses: hashicorp/setup-terraform@v3", "        with:", "          terraform_wrapper: false"];

  // Credentials are set per step, on the steps that need them, so a cloud
  // signed in by OIDC takes the session the sign-in step produced and a cloud
  // with stored keys takes the secrets. Job-level env would override both.
  const credEnv: string[] = [];
  for (const e of env) {
    if (e.env === "AWS_ACCESS_KEY_ID")
      credEnv.push(`          AWS_ACCESS_KEY_ID: \${{ steps.aws.outputs.aws-access-key-id || secrets.${e.secret} }}`);
    else if (e.env === "AWS_SECRET_ACCESS_KEY")
      credEnv.push(`          AWS_SECRET_ACCESS_KEY: \${{ steps.aws.outputs.aws-secret-access-key || secrets.${e.secret} }}`);
    else if (["ARM_CLIENT_ID", "ARM_TENANT_ID", "ARM_SUBSCRIPTION_ID"].includes(e.env))
      credEnv.push(`          ${e.env}: \${{ secrets.${e.secret} || vars.INFRALIFT_AZURE_${e.env.slice(4)} }}`);
    else credEnv.push(`          ${e.env}: \${{ secrets.${e.secret} }}`);
  }
  if (has("aws")) credEnv.push("          AWS_SESSION_TOKEN: ${{ steps.aws.outputs.aws-session-token }}");
  if (has("azure")) credEnv.push("          ARM_USE_OIDC: ${{ vars.INFRALIFT_AZURE_CLIENT_ID != '' && vars.INFRALIFT_AZURE_TENANT_ID != '' && vars.INFRALIFT_AZURE_SUBSCRIPTION_ID != '' && secrets.ARM_CLIENT_SECRET == '' }}");
  const withCreds = (extra: string[] = []) => (credEnv.length || extra.length ? ["        env:", ...extra, ...credEnv] : []);

  const oidcSteps: string[] = [];
  if (has("aws")) {
    oidcSteps.push(
      "",
      "      - name: Sign in to AWS with OIDC",
      "        id: aws",
      "        if: vars.INFRALIFT_AWS_ROLE_ARN != ''",
      "        uses: aws-actions/configure-aws-credentials@v4",
      "        with:",
      "          role-to-assume: ${{ vars.INFRALIFT_AWS_ROLE_ARN }}",
      "          aws-region: ${{ vars.INFRALIFT_AWS_REGION || 'us-east-1' }}",
      "          output-credentials: true"
    );
  }
  if (has("gcp")) {
    oidcSteps.push(
      "",
      "      - name: Sign in to Google Cloud with OIDC",
      "        if: vars.INFRALIFT_GCP_WORKLOAD_IDENTITY_PROVIDER != '' && vars.INFRALIFT_GCP_SERVICE_ACCOUNT != ''",
      "        uses: google-github-actions/auth@v2",
      "        with:",
      "          workload_identity_provider: ${{ vars.INFRALIFT_GCP_WORKLOAD_IDENTITY_PROVIDER }}",
      "          service_account: ${{ vars.INFRALIFT_GCP_SERVICE_ACCOUNT }}"
    );
  }

  // The secrets check: each cloud passes on its keys or its OIDC variables;
  // everything else needs its secret. Names are fixed or validated
  // identifiers, read with printenv because TF_VAR_ names may hold dashes.
  const checkLines = ['          missing=""', '          hint=""'];
  const grouped = new Set(groups.flatMap((g) => g.keys));
  const oidcFlags: string[] = [];
  for (const g of groups) {
    const flag = `OIDC_${g.cloud.toUpperCase()}`;
    oidcFlags.push(`          ${flag}: \${{ ${g.oidcVars.map((v) => `vars.${v} != ''`).join(" && ")} }}`);
    checkLines.push(`          if [ "$${flag}" != "true" ]; then`, '            before="$missing"');
    for (const k of g.keys) {
      checkLines.push(`            [ -n "$(printenv ${k})" ] || missing="$missing ${secretNameFor(k)}"`);
    }
    checkLines.push(`            [ "$missing" = "$before" ] || hint="$hint ${g.label} can use OIDC instead: set ${g.oidcVars.join(", ")}."`);
    checkLines.push("          fi");
  }
  for (const e of env) {
    if (grouped.has(e.env)) continue;
    checkLines.push(`          [ -n "$(printenv ${e.env})" ] || missing="$missing ${e.secret}"`);
  }
  checkLines.push(
    '          if [ -n "$missing" ]; then',
    '            echo "::error::Missing credentials. Add these repository secrets, then re-run:$missing.$hint"',
    "            exit 1",
    "          fi"
  );

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
    // Generating code commits it back to the pull request's branch.
    gen ? "  contents: write" : "  contents: read",
    // Lets a sign-in step request an OIDC token. Unused with stored keys.
    ...(groups.length ? ["  id-token: write"] : []),
    "",
    "concurrency:",
    `  group: infralift-import-${checkSlug(root.path)}-\${{ github.ref }}`,
    "  cancel-in-progress: true",
    "",
    "jobs:",
    "  plan:",
    `    name: ${CHECK_JOB_NAME}`,
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
    "    steps:",
    "      - uses: actions/checkout@v4",
    // The branch itself, not the merge ref, so a generated commit lands on it.
    ...(gen ? ["        with:", "          ref: ${{ github.head_ref || github.ref_name }}"] : []),
    ...setup,
    ...oidcSteps,
    "",
    "      - name: Check the credentials are set",
    ...withCreds(oidcFlags),
    "        run: |",
    ...checkLines,
    "",
    "      - name: Init",
    ...withCreds(),
    `        run: ${tf} init -input=false${backendConfig}`,
    ...(gen
      ? [
          "",
          // Once generated.tf is committed it is the customer's code: the
          // check never regenerates over it.
          "      - name: Generate code for the imported resources",
          "        id: gen",
          `        if: hashFiles(${yamlString(`${root.path ? `${root.path}/` : ""}generated.tf`).replace(/"/g, "'")}) == ''`,
          ...withCreds(),
          "        run: |",
          "          set +e",
          `          ${tf} plan -input=false -lock=false -no-color -generate-config-out=generated.tf > generate.log 2>&1`,
          "          set -e",
          '          if [ ! -s generated.tf ]; then',
          "            tail -n 80 generate.log",
          '            echo "::error::The plan failed before it could compare anything. Nothing was changed."',
          "            exit 1",
          "          fi",
          `          echo "generated $(grep -c '^resource ' generated.tf) resource blocks"`,
        ]
      : []),
    "",
    "      - name: Plan (read-only, no lock)",
    ...withCreds(),
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
    "          imports=$(jq '[.resource_changes[]? | select(.change.importing)] | length' plan.json)",
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
    '            if [ "$imports" -gt 0 ]; then',
    '              echo ""',
    '              echo "$imports resource(s) will be imported into state on apply. Importing changes nothing that is running."',
    "            fi",
    '            if [ "$drift" -gt 0 ]; then',
    '              echo ""',
    '              echo "$drift resource(s) were changed outside Terraform since the last apply."',
    "            fi",
    '          } >> "$GITHUB_STEP_SUMMARY"',
    // One annotation per outcome: infralift reads these back from the check
    // run to show the result, so their wording is part of the contract
    // (lib/import/result.ts).
    '          if [ "$changes" -eq 0 ]; then',
    '            echo "::notice::No changes: all $total resources match the code."',
    "          else",
    '            echo "::error::$changes of $total resources would change."',
    "            exit 1",
    "          fi",
    ...(gen
      ? [
          "",
          // Committed whether or not the plan passed: a failing plan is fixed
          // by editing this code, so the customer needs it in the branch.
          "      - name: Commit the generated code",
          "        if: always() && steps.gen.outcome == 'success'",
          "        env:",
          "          BRANCH: ${{ github.head_ref || github.ref_name }}",
          "        run: |",
          '          git config user.name "infralift"',
          '          git config user.email "infralift@users.noreply.github.com"',
          "          git add generated.tf",
          `          git commit -m ${yamlString(GENERATED_COMMIT_SUBJECT)} -m "Generated by plan -generate-config-out from the resources as they run. Edit freely; the check never regenerates over it."`,
          '          git push origin "HEAD:$BRANCH"',
        ]
      : []),
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
