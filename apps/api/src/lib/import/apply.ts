import { Document } from "yaml";
import type { RootModule } from "./scan.js";
import { checkSlug, isSafePath, prepareModule, script, type CheckFile, type Step } from "./check.js";
import { printDiagnostics } from "./guard.js";

// ---------------------------------------------------------------------------
// The apply workflow for an adopted module: the step that turns merged import
// blocks into state. The import check (check.ts) plans and never applies, on
// pull requests and on the schedule; this workflow runs only on a push to the
// branch the adoption merged into.
//
// One job, in the `production` environment: `plan -out` with the state lock,
// then `apply` of exactly that file in the same job. The plan file never
// leaves the runner. It holds state values in plaintext, sensitive ones
// included, so an artifact would publish them to anyone who can read the
// repository. And both the lock and the apply use the environment's
// credentials, so the repository's secrets can stay read-only for the check.
// The cost: a required reviewer approves before this run's plan exists. The
// pull request's check already showed it.
//
// Its concurrency group is its own and never cancels a run in progress: an
// apply stopped halfway leaves state locked. Every step runs under bash with
// pipefail. A fork's copy never runs it.
// ---------------------------------------------------------------------------

export function applyWorkflowPath(path: string): string {
  return `.github/workflows/infralift-apply-${checkSlug(path)}.yml`;
}

const HEADER = [
  " Managed by infralift. On a push to the default branch, in the `production`",
  " environment: plans this module and applies exactly that plan, in one job,",
  " so the plan file never leaves the runner. That apply is what records",
  " adopted resources in state.",
  " Add required reviewers to the environment to hold each apply for one.",
  " Pull requests and the daily drift check are the import check's, which",
  " never applies.",
].join("\n");

const PLAN = "infralift.tfplan";

export function renderApplyWorkflow(
  root: RootModule,
  opts: { branch: string; repo: string; backendConfigFile?: string | null }
): CheckFile {
  // Both are spliced into expressions, so they are refused rather than escaped.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(opts.branch) || opts.branch.includes("..")) {
    throw new Error(`refusing to write an apply workflow for the branch ${JSON.stringify(opts.branch)}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) {
    throw new Error(`refusing to write an apply workflow for the repository ${JSON.stringify(opts.repo)}`);
  }
  const file = applyWorkflowPath(root.path);
  const slug = checkSlug(root.path);
  const tf = root.tool;
  const dir = root.path || ".";
  if (!isSafePath(dir)) throw new Error(`refusing to write an apply workflow for the path ${JSON.stringify(dir)}`);
  const plan = prepareModule(root, { backendConfigFile: opts.backendConfigFile });
  const guard = `github.repository == '${opts.repo}' && github.event_name == 'push' && github.ref == 'refs/heads/${opts.branch}'`;

  const steps: Step[] = [
    { uses: "actions/checkout@v4" },
    ...plan.prepare,
    {
      name: "Plan",
      id: "plan",
      ...plan.withCreds(),
      run: script(
        "set +e",
        `${tf} plan -input=false -no-color -json -out=${PLAN} > plan.log 2>&1`,
        "code=$?",
        "set -e",
        'if [ "$code" -ne 0 ]; then',
        ...printDiagnostics("plan.log").map((l) => `  ${l}`),
        '  echo "::error::The plan failed, so nothing was applied."',
        "  exit 1",
        "fi",
        // plan.json holds values from state; it is read here and removed,
        // never printed and never uploaded.
        `${tf} show -json ${PLAN} > plan.json`,
        "changing='[.resource_changes[]? | select(.change.actions != [\"no-op\"] and .change.actions != [\"read\"])]'",
        'changes=$(jq "$changing | length" plan.json)',
        "imports=$(jq '[.resource_changes[]? | select(.change.importing)] | length' plan.json)",
        "{",
        '  echo "## infralift apply: $MODULE_LABEL"',
        '  echo ""',
        '  echo "$imports to import, $changes to change."',
        '  if [ "$changes" -gt 0 ]; then',
        '    echo ""',
        '    echo "| Action | Resource |"',
        '    echo "| --- | --- |"',
        '    jq -r "$changing | .[] | \\"| \\(.change.actions | join(\\", \\")) | \\`\\(.address)\\` |\\"" plan.json',
        "  fi",
        '} >> "$GITHUB_STEP_SUMMARY"',
        "rm -f plan.json",
        'if [ $((changes + imports)) -gt 0 ]; then',
        '  echo "apply=true" >> "$GITHUB_OUTPUT"',
        "else",
        '  echo "apply=false" >> "$GITHUB_OUTPUT"',
        '  echo "::notice::Nothing to apply: the plan imports and changes nothing."',
        "fi"
      ),
    },
    {
      name: "Apply the plan above",
      if: "steps.plan.outputs.apply == 'true'",
      ...plan.withCreds(),
      run: script(`${tf} apply -input=false -no-color ${PLAN}`),
    },
  ];

  const jobDefaults = { run: { shell: "bash", "working-directory": dir } };
  const oidc = plan.groups.length ? { "id-token": "write" } : {};
  const workflow = {
    name: `infralift apply: ${root.path || "repository root"}`,
    on: {
      push: {
        branches: [opts.branch],
        paths: [root.path ? `${root.path}/**` : "**/*.tf", file],
      },
    },
    permissions: { contents: "read", ...oidc },
    // `shell: bash` is `bash --noprofile --norc -eo pipefail {0}`; the
    // default shell has no pipefail.
    defaults: { run: { shell: "bash" } },
    concurrency: { group: `infralift-apply-${slug}`, "cancel-in-progress": false },
    jobs: {
      apply: {
        name: `infralift apply: ${slug}`,
        if: guard,
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 60,
        environment: "production",
        defaults: jobDefaults,
        env: plan.jobEnv,
        steps,
      },
    },
  };

  const doc = new Document(workflow);
  doc.commentBefore = HEADER;
  return { path: file, content: doc.toString({ lineWidth: 0 }) };
}
