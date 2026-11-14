import type { Step } from "./check.js";

// ---------------------------------------------------------------------------
// Cleaning up what `plan -generate-config-out` writes, before the gate plans it.
//
// Terraform generates resource code by writing every attribute the provider
// read back, including ones that hold the provider's "not set" value. Some
// providers then reject their own output. Measured 2026-11-14 with OpenTofu
// 1.12.6 and hashicorp/aws 5.100.0 (what adoption's `~> 5.0` resolves to),
// against moto: every one of nine AWS kinds failed `validate`, e.g.
// `bucket_prefix = ""` beside `bucket` (conflicts) and
// `fifo_throughput_scope = ""` (not one of the allowed values). So every AWS
// adoption check failed with "The plan failed before it could compare
// anything" until a person deleted those lines by hand.
//
// The fix is a table, not a heuristic. Each entry names one attribute of one
// resource type and the exact condition under which the generated line is
// removed:
//
//   placeholder  the line holds exactly the provider's "not set" value ("" or
//                0) for an attribute whose validation rejects that value.
//                Removing it says what the placeholder meant: not set.
//   derivedFrom  the attribute is computed by the provider from another one
//                that the block sets (a name prefix from the name, a zone id
//                from the zone), and the two may not both be written. The one
//                kept still pins the same thing.
//
// Why this cannot hide a real difference: the gate plans the cleaned code
// against what is running. If removing an attribute changed what Terraform
// wants, the plan shows that change and the check fails as it should. A
// removal only passes when the provider reads the same value back from the
// real resource, which is the definition of "no difference". No rule uses
// lifecycle ignore_changes, which is the tool that would hide one.
//
// Where it runs: in the customer's CI, inside the import check workflow, right
// after generation and before the secret guard and the gate (check.ts). It is
// a POSIX awk program written into the workflow, like the guard's, so it runs
// the same under mawk (ubuntu runners), BSD awk and busybox (the e2e stack).
// It only ever touches a file it just generated: once generated.tf is
// committed it is the customer's code, and the check never rewrites it.
//
// What it reads, and what it refuses to guess about: generated code is printed
// the way `fmt` prints it, so a resource block starts with
// `resource "<type>" "<name>" {` at column 0 and ends with `}` at column 0, its
// own attributes sit at exactly two spaces, and a nested block's at four. The
// program removes only single lines of that shape whose whole value is the
// placeholder or a quoted string; a value that spans lines, anything inside a
// heredoc, and anything outside a resource block is passed through untouched.
//
// Strategy table: adding a provider quirk is one entry here, with the
// diagnostic that justified it. Measure first (a generated snippet, the
// validate error, a plan of zero changes after removal), then add the entry
// and a fixture test in cleanup.test.ts.
// ---------------------------------------------------------------------------

/** Remove the line when it holds exactly this "not set" value. */
export interface PlaceholderRule {
  /** An attribute of the resource, or `block.attribute` for one level of
   *  nested block. */
  attribute: string;
  placeholder: '""' | "0";
  /** The provider's diagnostic on the placeholder, for the log and the reader. */
  why: string;
}

/** Remove the line when the block also sets `derivedFrom` to a real value. */
export interface DerivedRule {
  attribute: string;
  derivedFrom: string;
  why: string;
}

export type CleanupRule = PlaceholderRule | DerivedRule;

const NAME_PREFIX = "computed from the name, which is set; the two conflict";
const NOT_AN_ALLOWED_VALUE = "empty means not set, and the provider only accepts its listed values";
const OUT_OF_RANGE = "0 means not set, and the provider rejects 0 as out of range";
const EMPTY_INVALID = "empty means not set, and the provider rejects an empty value";
const EMPTY_CONFLICTS = "empty means not set, and the provider rejects it beside a conflicting attribute";

/**
 * The rules, per Terraform resource type. Every entry was measured on
 * 2026-11-14 with OpenTofu 1.12.6, hashicorp/aws 5.100.0 and moto 5.2.5, not
 * against real AWS: each is a `tofu validate` error that generated code
 * produced. With them removed, a probe of nine kinds planned "9 to import,
 * 0 to change, 0 to destroy", and `make e2e` plans its eight adoptable kinds
 * the same way on the first run. Snippets: __fixtures__/generated-aws-moto.tf.
 *
 * Deliberately absent: `aws_kms_key.key_usage = ""`. moto omits KeyUsage for a
 * key created without one; the provider then defaults it to ENCRYPT_DECRYPT
 * and the plan replaces the key (measured). AWS documents KeyUsage as part of
 * every key's metadata, so real keys should not hit this, but that is not
 * verified here. Removing the line would not hide anything (the plan shows the
 * replacement), but it would turn a validate error into a replacement, so the
 * line is left for the gate to refuse.
 *
 * aws_sqs_queue is not here because it is not adoptable yet: see the sqs entry
 * in adopters/aws.ts.
 */
export const GENERATED_CLEANUP_RULES: Readonly<Record<string, readonly CleanupRule[]>> = {
  aws_s3_bucket: [{ attribute: "bucket_prefix", derivedFrom: "bucket", why: "computed from the bucket name, which is set; the two conflict" }],
  aws_security_group: [{ attribute: "name_prefix", derivedFrom: "name", why: NAME_PREFIX }],
  aws_sns_topic: [
    { attribute: "name_prefix", derivedFrom: "name", why: NAME_PREFIX },
    { attribute: "fifo_throughput_scope", placeholder: '""', why: NOT_AN_ALLOWED_VALUE },
    { attribute: "signature_version", placeholder: "0", why: OUT_OF_RANGE },
    { attribute: "tracing_config", placeholder: '""', why: NOT_AN_ALLOWED_VALUE },
  ],
  aws_cloudwatch_log_group: [
    { attribute: "name_prefix", derivedFrom: "name", why: NAME_PREFIX },
    { attribute: "log_group_class", placeholder: '""', why: NOT_AN_ALLOWED_VALUE },
  ],
  aws_dynamodb_table: [{ attribute: "point_in_time_recovery.recovery_period_in_days", placeholder: "0", why: OUT_OF_RANGE }],
  aws_kms_key: [
    { attribute: "custom_key_store_id", placeholder: '""', why: EMPTY_INVALID },
    { attribute: "rotation_period_in_days", placeholder: "0", why: OUT_OF_RANGE },
    { attribute: "xks_key_id", placeholder: '""', why: EMPTY_INVALID },
  ],
  aws_vpc: [
    { attribute: "ipv6_cidr_block", placeholder: '""', why: EMPTY_CONFLICTS },
    { attribute: "ipv6_ipam_pool_id", placeholder: '""', why: EMPTY_CONFLICTS },
    { attribute: "ipv6_netmask_length", placeholder: "0", why: EMPTY_CONFLICTS },
  ],
  aws_subnet: [
    {
      attribute: "availability_zone_id",
      derivedFrom: "availability_zone",
      why: "the same zone as availability_zone, which is set; the two conflict",
    },
    { attribute: "enable_lni_at_device_index", placeholder: "0", why: "0 means not set, and the provider rejects 0" },
    { attribute: "ipv6_cidr_block", placeholder: '""', why: "empty means not set, and the provider rejects an empty CIDR block" },
  ],
};

/** The step's name, which the e2e harness runs by. */
export const CLEANUP_STEP_NAME = "Remove generated attributes the provider rejects";

const TYPE = /^[a-z][a-z0-9_]*$/;
const ATTRIBUTE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/;
/** A reason goes into an awk string inside a single-quoted shell word. */
const WHY = /^[A-Za-z0-9 ,;.()_-]+$/;

/** The rules for the resource types a module holds, in a fixed order. */
export function rulesFor(resourceTypes: Iterable<string>): [string, readonly CleanupRule[]][] {
  const wanted = new Set(resourceTypes);
  return Object.entries(GENERATED_CLEANUP_RULES)
    .filter(([type]) => wanted.has(type))
    .sort(([a], [b]) => a.localeCompare(b));
}

/** The table as awk assignments. Names and reasons are checked rather than
 *  escaped: they are fixed strings in this file, and a check here fails a test
 *  instead of writing a broken workflow. */
function ruleAssignments(rules: [string, readonly CleanupRule[]][]): string[] {
  const lines: string[] = [];
  for (const [type, list] of rules) {
    if (!TYPE.test(type)) throw new Error(`cleanup rule type ${JSON.stringify(type)} is not a resource type name`);
    for (const rule of list) {
      if (!ATTRIBUTE.test(rule.attribute)) throw new Error(`cleanup rule attribute ${JSON.stringify(rule.attribute)} is not an attribute name`);
      if (!WHY.test(rule.why)) throw new Error(`cleanup rule reason ${JSON.stringify(rule.why)} has characters the awk program cannot hold`);
      const key = `${type} ${rule.attribute}`;
      if ("placeholder" in rule) {
        // In awk source "\"\"" is the two-character string "".
        lines.push(`  placeholder["${key}"] = ${rule.placeholder === '""' ? '"\\"\\""' : '"0"'}`);
      } else {
        if (!ATTRIBUTE.test(rule.derivedFrom) || rule.derivedFrom.includes(".")) {
          throw new Error(`cleanup rule derivedFrom ${JSON.stringify(rule.derivedFrom)} must be a top-level attribute`);
        }
        lines.push(`  derived["${key}"] = "${rule.derivedFrom}"`);
      }
      lines.push(`  why["${key}"] = "${rule.why}"`);
    }
  }
  return lines;
}

/**
 * The awk program for `rules`. Reads generated.tf, writes the cleaned file to
 * the path in the awk variable `out`, and prints one line per removal on
 * stdout: `generated.tf:<line>: removed <attribute> from <address>: <why>`.
 * Values are never printed. No single quote anywhere: it is passed to awk in
 * single quotes.
 *
 * Each resource block is buffered until its closing brace, because a
 * derivedFrom rule depends on an attribute that may come later in the block.
 */
export function cleanupAwk(rules: [string, readonly CleanupRule[]][]): string {
  return [
    `BEGIN {`,
    ...ruleAssignments(rules),
    `  inres = 0; n = 0; removed = 0`,
    // Creates the output even when generated.tf is empty, so the mv after it has a file.
    `  printf "" > out`,
    `}`,
    // Buffer one line of the current block with the attribute it sets, if any.
    `function keep(line, key, val) { n++; buf[n] = line; keys[n] = key; vals[n] = val; nums[n] = NR }`,
    `function drop(i,   r) {`,
    `  if (keys[i] == "") return 0`,
    `  r = rtype " " keys[i]`,
    `  if (r in placeholder) return vals[i] == placeholder[r]`,
    // Only a single-line quoted string, so nothing spanning lines is cut in half.
    `  if (r in derived) return (derived[r] in present) && vals[i] ~ /^"[^"]*"$/`,
    `  return 0`,
    `}`,
    `function flush(   i) {`,
    `  for (i = 1; i <= n; i++) {`,
    `    if (drop(i)) {`,
    `      printf "generated.tf:%d: removed %s from %s.%s: %s\\n", nums[i], keys[i], rtype, rname, why[rtype " " keys[i]]`,
    `      removed++`,
    `    } else print buf[i] > out`,
    `  }`,
    `  n = 0`,
    `}`,
    `{`,
    `  line = $0`,
    `  if (!inres) {`,
    `    if (line ~ /^resource "[A-Za-z0-9_-]+" "[^"]+" [{]$/) {`,
    `      rtype = line; sub(/^resource "/, "", rtype); sub(/".*$/, "", rtype)`,
    `      rname = line; sub(/^resource "[^"]*" "/, "", rname); sub(/" [{]$/, "", rname)`,
    `      inres = 1; nested = ""; heredoc = ""; split("", present)`,
    `      keep(line, "", ""); next`,
    `    }`,
    `    print line > out; next`,
    `  }`,
    // Heredoc bodies are opaque: their lines can look like anything.
    `  if (heredoc != "") {`,
    `    keep(line, "", ""); t = line; sub(/^[ \\t]+/, "", t)`,
    `    if (t == heredoc) heredoc = ""`,
    `    next`,
    `  }`,
    `  if (line == "}") { keep(line, "", ""); flush(); inres = 0; next }`,
    `  if (line ~ /<<-?[A-Za-z_][A-Za-z0-9_]*$/) {`,
    `    heredoc = line; sub(/^.*<<-?/, "", heredoc)`,
    `    keep(line, "", ""); next`,
    `  }`,
    `  if (line ~ /^  [a-z0-9_]+ [{]$/) { nested = line; sub(/^  /, "", nested); sub(/ [{]$/, "", nested); keep(line, "", ""); next }`,
    `  if (line == "  }") { nested = ""; keep(line, "", ""); next }`,
    `  key = ""`,
    `  if (nested == "" && line ~ /^  [a-z0-9_]+ +=/) key = line`,
    `  else if (nested != "" && line ~ /^    [a-z0-9_]+ +=/) key = line`,
    `  if (key == "") { keep(line, "", ""); next }`,
    `  sub(/^ +/, "", key); sub(/ *=.*$/, "", key)`,
    `  val = line; sub(/^ *[a-z0-9_]+ *= */, "", val); sub(/ +$/, "", val)`,
    `  if (nested != "") key = nested "." key`,
    `  else if (val != "null" && val != "\\"\\"") present[key] = 1`,
    `  keep(line, key, val)`,
    `}`,
    // A block that never closed (not something Terraform writes) is passed
    // through as it was, with nothing removed.
    `END {`,
    `  if (inres) for (i = 1; i <= n; i++) print buf[i] > out`,
    `  if (removed) printf "removed %d generated attribute(s) the provider rejects\\n", removed`,
    `  else print "nothing to remove from generated.tf"`,
    `}`,
  ].join("\n");
}

/** The workflow step that cleans generated.tf, for a module holding these
 *  resource types, or null when no rule applies to any of them (the step is
 *  then left out, and the workflow is what it was before this existed).
 *  Runs only when the generate step ran and produced a file. */
export function cleanupStep(resourceTypes: Iterable<string>): Step | null {
  const rules = rulesFor(resourceTypes);
  if (!rules.length) return null;
  return {
    name: CLEANUP_STEP_NAME,
    if: "steps.gen.outcome == 'success'",
    run: [
      `awk -v out=generated.tf.cleaned '${cleanupAwk(rules)}' generated.tf`,
      // Replaced only once awk finished: a failure leaves the generated file as it was.
      "mv generated.tf.cleaned generated.tf",
      "",
    ].join("\n"),
  };
}
