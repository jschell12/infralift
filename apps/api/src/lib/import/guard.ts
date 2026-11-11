import type { Step } from "./check.js";

// ---------------------------------------------------------------------------
// What the check is allowed to print and to commit.
//
// generated.tf is written from what is running, so a provider that does not
// mark an attribute sensitive hands its value to `plan -generate-config-out`
// as a literal, and committing it puts a credential in git history. Before the
// check commits generated.tf it scans it twice: once for attributes whose names
// say they hold a secret and whose value is a literal, and once with gitleaks.
// Either finding stops the commit. Findings name a line and an attribute or a
// rule, never a value.
//
// Logs follow the same rule. A failed plan prints its error diagnostics (what
// Terraform chose to say, with its own redaction), not the plan's output.
// ---------------------------------------------------------------------------

export const GITLEAKS_VERSION = "8.30.1";
/** sha256 of gitleaks_<version>_linux_x64.tar.gz, from the release's
 *  checksums file, checked against the downloaded tarball on 2026-11-10. */
export const GITLEAKS_SHA256 = "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb";

/** Words that make an attribute name sensitive, matched as whole
 *  underscore-separated words: `master_password`, `db_password_value`, but
 *  not `passwordless`. */
export const SENSITIVE_WORDS = [
  "password", "passwd", "passphrase", "secret", "token", "private_key", "api_key", "apikey",
  "access_key", "connection_string", "credential", "credentials", "config_vars",
] as const;

/** Names that carry a sensitive word but hold a reference or a setting:
 *  `secret_arn`, `kms_key_id`, `token_length`, `secret_version_stage`. */
const NOT_A_VALUE = "_(arn|arns|id|ids|name|names|version|versions|type|types|length|enabled|ttl|count|days|validity|units|mode|policy|stage|stages)$";

// POSIX awk, so it runs the same under mawk (ubuntu runners) and BSD awk.
// No single quote anywhere: it is passed to awk in single quotes.
//
// Names are matched, so a secret under an innocent name (`description`, a map
// key like `"x"`) gets past this scan; gitleaks is the backstop, and it finds
// only known formats and high-entropy values. Two common shapes are covered:
// quoted map keys (`"db-password" = ...`, dashes read as underscores) and
// name/value pairs, as in ECS container definitions written as
// `jsonencode([{ name = "DB_PASSWORD", value = "..." }])`.
const AWK = [
  "function sensitive(n,   w, i) {",
  `  if (n ~ /${NOT_A_VALUE}/) return 0`,
  '  w = "_" n "_"',
  '  for (i = 1; i <= nw; i++) if (index(w, "_" words[i] "_")) return 1',
  "  return 0",
  "}",
  'function report(ln, nm) { printf "%s:%d: %s holds a literal value\\n", FILENAME, ln, nm; found++ }',
  `BEGIN { nw = split("${SENSITIVE_WORDS.join(" ")}", words, " ") }`,
  "{",
  '  if (pend != "") {',
  '    t = $0; sub(/^[ \\t]+/, "", t)',
  '    if (t != "") { if (t !~ /^[]}]/) report(pendln, pend); pend = "" }',
  "  }",
  // A sensitive name in a name/value pair holds the next value seen.
  '  if (match($0, /(^|[^A-Za-z0-9_])name[ \\t]*=[ \\t]*"[^"]*"/)) {',
  '    s = substr($0, RSTART, RLENGTH); sub(/^.*name[ \\t]*=[ \\t]*"/, "", s); sub(/"$/, "", s)',
  '    s = tolower(s); gsub(/-/, "_", s); if (sensitive(s)) { nv = s; nvln = NR }',
  "  }",
  '  if (nv != "" && match($0, /(^|[^A-Za-z0-9_])value[ \\t]*=[ \\t]*[^ \\t,}]+/)) {',
  '    s = substr($0, RSTART, RLENGTH); sub(/^.*value[ \\t]*=[ \\t]*/, "", s)',
  '    if (s !~ /^(null|""|true|false)$/ && s !~ /^-?[0-9.]+$/) report(NR, nv)',
  '    nv = ""',
  "  }",
  '  if ($0 ~ /}/) nv = ""',
  '  if ($0 !~ /^[ \\t]*"?[A-Za-z0-9_-]+"?[ \\t]*=/) next',
  '  name = $0; sub(/^[ \\t]+/, "", name); sub(/[ \\t]*=.*/, "", name); gsub(/"/, "", name); name = tolower(name); gsub(/-/, "_", name)',
  "  if (!sensitive(name)) next",
  '  v = $0; sub(/^[^=]*=[ \\t]*/, "", v); sub(/[ \\t]+$/, "", v)',
  // null (Terraform writes `null # sensitive`), empty, booleans, numbers.
  '  if (v ~ /^(null|true|false|""|\\{\\}|\\[\\])([ \\t#]|$)/ || v ~ /^-?[0-9.]+([ \\t#]|$)/) next',
  '  if (v == "{" || v == "[") { pend = name; pendln = NR; next }',
  "  report(NR, name)",
  "}",
  'END { if (pend != "") report(pendln, pend); exit (found > 0) }',
].join("\n");

/** Prints a JSON-lines plan log's error diagnostics, and nothing else. A
 *  plan that fails before its JSON starts (bad flags, a crashed provider)
 *  wrote plain text instead, which is Terraform's own stderr, so that is
 *  printed. */
export function printDiagnostics(log: string): string[] {
  return [
    `out=$(jq -rR 'fromjson? | select(."@level" == "error") | .diagnostic | "Error: \\(.summary)\\(if .address then " (\\(.address))" else "" end)\\(if .detail then ": \\(.detail[0:300])" else "" end)"' ${log} | head -n 20 || true)`,
    `[ -n "$out" ] || out=$(grep -v '^{' ${log} | head -n 20 || true)`,
    'printf "%s\\n" "${out:-Terraform printed no diagnostics.}"',
  ];
}

/** Steps between generating generated.tf and committing it. Gated on the
 *  generate step `gen`; the commit step requires `guard` to have passed. */
export function secretGuardSteps(): Step[] {
  const tarball = `gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`;
  return [
    {
      name: "Install gitleaks",
      if: "steps.gen.outcome == 'success'",
      run: [
        'cd "$RUNNER_TEMP"',
        `curl -sSfLo gitleaks.tgz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${tarball}"`,
        `echo "${GITLEAKS_SHA256}  gitleaks.tgz" | sha256sum -c -`,
        "tar xzf gitleaks.tgz gitleaks",
        "",
      ].join("\n"),
    },
    {
      name: "Check the generated code holds no secrets",
      id: "guard",
      if: "steps.gen.outcome == 'success'",
      env: { GITLEAKS: "${{ runner.temp }}/gitleaks" },
      run: [
        "bad=0",
        `awk '${AWK}' generated.tf || bad=1`,
        'report="$RUNNER_TEMP/gitleaks.json"',
        "set +e",
        '"$GITLEAKS" dir generated.tf --no-banner --redact --exit-code 2 --report-format json --report-path "$report" > /dev/null 2>&1',
        "code=$?",
        "set -e",
        'if [ "$code" -eq 2 ]; then',
        `  jq -r '.[] | "generated.tf:\\(.StartLine): gitleaks rule \\(.RuleID)"' "$report"`,
        "  bad=1",
        'elif [ "$code" -ne 0 ]; then',
        '  echo "::error::gitleaks could not scan generated.tf, so it was not committed."',
        "  exit 1",
        "fi",
        'if [ "$bad" -ne 0 ]; then',
        '  echo "::error::generated.tf was not committed: it holds values that look like secrets (lines above; values are not shown). Commit generated.tf to this branch yourself with those values moved into variables, and the check will use it instead of generating."',
        "  exit 1",
        "fi",
        "",
      ].join("\n"),
    },
  ];
}
