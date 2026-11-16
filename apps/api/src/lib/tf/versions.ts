import type { VersionItem, VersionStatus } from "@infralift/shared";
import { HclParseError, parseHcl, type HclBlock } from "../import/hcl.js";
import { PROVIDER_VERSIONS, REQUIRED_VERSION, type RequiredVersionFloor } from "./baseline.js";

// ---------------------------------------------------------------------------
// Version lag (ADR 0012, phase 1): what a customer's repository pins, read
// statically, and how far that is behind the version baseline.
//
// Two halves, kept apart so the expensive one can be cached:
//
//   facts      what the repository says: the providers its
//              .terraform.lock.hcl pins, the required_providers constraints
//              and required_version in the root module's *.tf. Read once per
//              interval by services/versions.ts and stored on the project.
//   classify   those facts against baseline.ts, at read time, so moving a pin
//              in baseline.ts reclassifies every project without re-reading
//              a single repository.
//
// What this does not handle, on purpose:
//   - Modules' own required_providers. Only the root module is read: its lock
//     file is what init installs for the whole configuration.
//   - Pre-release versions ("1.10.0-beta1"): read as unknown, not compared.
//   - Constraints built from expressions or variables: Terraform does not
//     allow them in these places, so they do not occur in a file that inits.
//   - Upper bounds ("< 6.0"): only the lowest version a constraint allows is
//     compared, because that is what "behind" means for a pin.
// ---------------------------------------------------------------------------

export type Semver = readonly [number, number, number];

/** "5.28.1", "1.5" or "v1.5.0" as numbers; null for anything else, including
 *  pre-releases. A missing minor or patch is 0, as Terraform reads it. */
export function parseVersion(text: string): Semver | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function compareVersions(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

export const formatVersion = (v: Semver) => v.join(".");

/**
 * The lowest version a Terraform version constraint allows: "~> 5.28" gives
 * 5.28.0, ">= 1.5" gives 1.5.0, "5.24.0" and "= 5.24.0" give 5.24.0. With
 * several parts (">= 1.6, >= 1.8", which is how required_version reads when
 * two files set it) the highest lower bound wins, because Terraform must
 * satisfy all of them. Upper bounds and exclusions are skipped. Null when no
 * part is a lower bound this can read.
 */
export function constraintFloor(constraint: string): Semver | null {
  let floor: Semver | null = null;
  for (const part of constraint.split(",")) {
    const m = /^(~>|>=|>|=)?\s*(\S+)$/.exec(part.trim());
    if (!m) continue;
    const v = parseVersion(m[2]!);
    if (!v) continue;
    if (!floor || compareVersions(v, floor) > 0) floor = v;
  }
  return floor;
}

/** have against the lowest version infralift asks for. */
export function classifyVersion(have: Semver, want: Semver): VersionStatus {
  if (compareVersions(have, want) >= 0) return "current";
  return have[0] < want[0] ? "behind-major" : "behind-minor";
}

const RANK: Record<VersionStatus, number> = { current: 0, unknown: 1, "behind-minor": 2, "behind-major": 3 };

/** The worst of several statuses. Behind beats unknown: a project with one
 *  provider two majors back is behind, whatever else could not be read. */
export function worstStatus(statuses: VersionStatus[]): VersionStatus {
  let worst: VersionStatus = "current";
  for (const s of statuses) if (RANK[s] > RANK[worst]) worst = s;
  return worst;
}

// -- facts ------------------------------------------------------------------

export interface LockedProvider {
  /** "hashicorp/aws": the registry host dropped, so a Terraform and an
   *  OpenTofu lock file name the same provider the same way. */
  source: string;
  /** registry.terraform.io or registry.opentofu.org. */
  registry: string;
  version: string | null;
}

export interface ProviderConstraint {
  source: string;
  constraint: string | null;
}

/** What one repository directory pins. Stored as JSON on the project
 *  (TfProject.versionFacts), so every field is plain data. */
export interface RepoVersionFacts {
  ok: true;
  ref: string;
  /** The root module's directory, "" = the repository root. */
  path: string;
  lockFound: boolean;
  locked: LockedProvider[];
  constraints: ProviderConstraint[];
  /** required_version from every file that sets it, joined with ", " (all
   *  must hold), or null when none does. */
  requiredVersion: string | null;
  /** What was skipped or could not be parsed, so a partial read never reads
   *  as a full one. */
  notes: string[];
}

/** A read that failed, in words a customer can act on. */
export interface RepoVersionProblem {
  ok: false;
  ref: string | null;
  path: string;
  problem: string;
}

export type StoredVersionFacts = RepoVersionFacts | RepoVersionProblem;

/** The providers a .terraform.lock.hcl pins. Each is a block
 *  `provider "registry.terraform.io/<ns>/<name>" { version = "x.y.z" ... }`,
 *  which is all `terraform init` and `tofu init` write there. */
export function parseLockFile(src: string): LockedProvider[] {
  const out: LockedProvider[] = [];
  for (const block of parseHcl(src).blocks) {
    if (block.type !== "provider" || !block.labels[0]) continue;
    const parts = block.labels[0].toLowerCase().split("/");
    if (parts.length < 3) continue;
    out.push({
      source: parts.slice(-2).join("/"),
      registry: parts.slice(0, -2).join("/"),
      version: block.body.attrs.version?.str ?? null,
    });
  }
  return out.sort((a, b) => a.source.localeCompare(b.source));
}

/** required_version and required_providers from a root module's *.tf files.
 *  A file that does not parse is named in `notes` and left out. */
export function parseRootConstraints(files: { path: string; content: string }[]): {
  requiredVersion: string | null;
  constraints: ProviderConstraint[];
  notes: string[];
} {
  const versions: string[] = [];
  const constraints = new Map<string, string | null>();
  const notes: string[] = [];
  for (const file of files) {
    let blocks: HclBlock[];
    try {
      blocks = parseHcl(file.content).blocks;
    } catch (err) {
      if (!(err instanceof HclParseError)) throw err;
      notes.push(`${file.path} could not be parsed and was left out.`);
      continue;
    }
    for (const t of blocks.filter((b) => b.type === "terraform")) {
      const rv = t.body.attrs.required_version?.str;
      if (rv && !versions.includes(rv)) versions.push(rv);
      for (const rp of t.body.blocks.filter((b) => b.type === "required_providers")) {
        for (const [name, attr] of Object.entries(rp.body.attrs)) {
          // The same reading as the import scan (lib/import/scan.ts): an
          // object with source and version, or the legacy bare version string.
          const source = (/source\s*=\s*"([^"]+)"/.exec(attr.raw)?.[1] ?? `hashicorp/${name}`).toLowerCase();
          const version = attr.str ?? /version\s*=\s*"([^"]+)"/.exec(attr.raw)?.[1] ?? null;
          // Drop a registry host so "registry.terraform.io/hashicorp/aws" and
          // "hashicorp/aws" are one provider.
          const short = source.split("/").slice(-2).join("/");
          if (!constraints.has(short) || constraints.get(short) === null) constraints.set(short, version);
        }
      }
    }
  }
  return {
    requiredVersion: versions.length ? versions.join(", ") : null,
    constraints: [...constraints].map(([source, constraint]) => ({ source, constraint })).sort((a, b) => a.source.localeCompare(b.source)),
    notes,
  };
}

/** Facts from the files read: the root module's *.tf and its lock file
 *  (null when there is none). */
export function factsFromFiles(opts: {
  ref: string;
  path: string;
  tfFiles: { path: string; content: string }[];
  lockFile: string | null;
  notes?: string[];
}): RepoVersionFacts {
  const root = parseRootConstraints(opts.tfFiles);
  const notes = [...(opts.notes ?? []), ...root.notes];
  let locked: LockedProvider[] = [];
  if (opts.lockFile !== null) {
    try {
      locked = parseLockFile(opts.lockFile);
    } catch (err) {
      if (!(err instanceof HclParseError)) throw err;
      notes.push(".terraform.lock.hcl could not be parsed.");
    }
  }
  return {
    ok: true,
    ref: opts.ref,
    path: opts.path,
    lockFound: opts.lockFile !== null,
    locked,
    constraints: root.constraints,
    requiredVersion: root.requiredVersion,
    notes,
  };
}

// -- classify ---------------------------------------------------------------

const where = (path: string) => (path ? path : "the repository root");

/** Each provider the repository pins or declares, against the baseline.
 *  Only a lock file says what is installed; a constraint alone is shown but
 *  not compared, because "~> 5.0" may have installed 5.0.0 or 5.99.0. */
export function classifyProviders(
  facts: RepoVersionFacts,
  baseline: Readonly<Record<string, string>> = PROVIDER_VERSIONS
): VersionItem[] {
  const sources = new Set([...facts.locked.map((l) => l.source), ...facts.constraints.map((c) => c.source)]);
  return [...sources].sort().map((source) => {
    const locked = facts.locked.find((l) => l.source === source);
    const constraint = facts.constraints.find((c) => c.source === source)?.constraint ?? null;
    const want = baseline[source] ?? null;
    const item = (status: VersionStatus, have: string | null, note: string | null): VersionItem => ({ name: source, have, want, status, note });

    if (!facts.lockFound) {
      return item("unknown", null, `No .terraform.lock.hcl in ${where(facts.path)}, so the installed version is not known${constraint ? ` (the code asks for ${constraint})` : ""}.`);
    }
    if (!locked?.version) {
      return item("unknown", null, `Declared${constraint ? ` as ${constraint}` : ""} but not in the lock file. The next init adds it.`);
    }
    if (!want) return item("unknown", locked.version, "infralift's baseline does not pin this provider, so there is nothing to compare it with.");
    const have = parseVersion(locked.version);
    const floor = constraintFloor(want);
    if (!have || !floor) return item("unknown", locked.version, `Could not compare ${locked.version} with ${want}.`);
    return item(classifyVersion(have, floor), locked.version, null);
  });
}

/** The repository's required_version against the floor infralift writes
 *  for this kind of project. */
export function classifyRequiredVersion(facts: RepoVersionFacts, floor: RequiredVersionFloor): VersionItem {
  const want = REQUIRED_VERSION[floor];
  const base = { name: "terraform", have: facts.requiredVersion, want };
  if (!facts.requiredVersion) {
    return { ...base, status: "unknown", note: `No required_version in ${where(facts.path)}: any Terraform or OpenTofu version may run it.` };
  }
  const have = constraintFloor(facts.requiredVersion);
  const wantFloor = constraintFloor(want);
  if (!have || !wantFloor) return { ...base, status: "unknown", note: `Could not compare ${facts.requiredVersion} with ${want}.` };
  return { ...base, status: classifyVersion(have, wantFloor), note: null };
}

/** Which floor a project is held to: catalog stacks are written against the
 *  stack floor, everything else infralift generates against the generated
 *  one. A repository infralift did not write (an import) is held to the
 *  lowest floor, since that is the least infralift's own code would ask. */
export function floorForKind(kind: string): RequiredVersionFloor {
  return kind === "stack" ? "stack" : "generated";
}

/** A stack release against the newest one. Null either side is unknown. */
export function classifyRelease(have: string | null, newest: string | null, unknownNote: string): VersionItem {
  const base = { name: "stack release", have, want: newest };
  const h = have ? parseVersion(have) : null;
  const n = newest ? parseVersion(newest) : null;
  if (!h || !n) return { ...base, status: "unknown", note: unknownNote };
  return { ...base, status: classifyVersion(h, n), note: null };
}
