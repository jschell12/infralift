import { z } from "zod";
import type { VercelSnapshot } from "@infralift/collectors/vercel";
import type { HerokuSnapshot } from "@infralift/collectors/heroku";
import type { ConnectorAssessment } from "./types.js";
import { analyzeVercel } from "./vercel.js";
import { analyzeHeroku } from "./heroku.js";

// A bundle is a snapshot produced by packages/collectors and uploaded by the
// customer, for the case where handing us a provider token is not something
// their security review will approve.
//
// Unlike a connector, everything here is untrusted input: the file arrived
// over HTTP from a browser and may have been edited, truncated, replayed, or
// hand-written. So it is validated rather than cast, every array is bounded,
// and the parse result carries provenance the report can display.

/** Snapshot schema versions this build understands. */
export const SUPPORTED_SCHEMA_VERSIONS = [1];

/** Bounds. Generous next to any real account, small enough that a malicious
 * upload cannot turn into a million-row insert. Express already caps the body
 * at 1mb; these cap what that body can expand into. */
const MAX_PROJECTS = 2000;
const MAX_DOMAINS = 2000;
const MAX_APPS = 2000;
const MAX_FORMATION = 200;
const MAX_ADDONS = 200;

const str = z.string().max(2048).nullable();
const collector = z.object({
  name: z.string().max(200),
  version: z.string().max(50),
});

const vercelSnapshotSchema = z.object({
  schemaVersion: z.number().int(),
  provider: z.literal("vercel"),
  collector,
  collectedAt: z.string().datetime(),
  projects: z
    .array(
      z.object({
        id: str,
        name: str,
        framework: str,
        nodeVersion: str,
        serverlessFunctionRegion: str,
        // A count, never contents. Rejecting anything but a number here is
        // also what stops an edited bundle smuggling an env array through.
        envVarCount: z.number().int().min(0).max(100000).nullable(),
        buildCommand: str,
        outputDirectory: str,
        rootDirectory: str,
        installCommand: str,
        devCommand: str,
        link: z
          .object({
            type: str,
            org: str,
            repo: str,
            productionBranch: str,
          })
          .nullable(),
      })
    )
    .max(MAX_PROJECTS),
  domains: z
    .array(z.object({ id: str, name: str, serviceType: str }))
    .max(MAX_DOMAINS),
  domainsRead: z.boolean(),
});

const herokuSnapshotSchema = z.object({
  schemaVersion: z.number().int(),
  provider: z.literal("heroku"),
  collector,
  collectedAt: z.string().datetime(),
  apps: z
    .array(
      z.object({
        id: str,
        name: str,
        region: str,
        stack: str,
        maintenance: z.boolean(),
        formation: z
          .array(
            z.object({
              type: str,
              size: str,
              quantity: z.number().int().min(0).max(100000),
            })
          )
          .max(MAX_FORMATION),
        formationRead: z.boolean(),
        addons: z
          .array(
            z.object({
              id: str,
              name: str,
              addonServiceName: str,
              planName: str,
              billedPriceCents: z.number().int().min(0).max(100000000).nullable(),
            })
          )
          .max(MAX_ADDONS),
        addonsRead: z.boolean(),
      })
    )
    .max(MAX_APPS),
});

const bundleSchema = z.discriminatedUnion("provider", [
  vercelSnapshotSchema,
  herokuSnapshotSchema,
]);

export type BundleSnapshot = VercelSnapshot | HerokuSnapshot;

export interface ParsedBundle {
  provider: "vercel" | "heroku";
  snapshot: BundleSnapshot;
  collectorVersion: string;
  collectedAt: Date;
}

export class BundleError extends Error {
  constructor(
    message: string,
    readonly detail?: string
  ) {
    super(message);
    this.name = "BundleError";
  }
}

/**
 * Validate an uploaded snapshot. Throws BundleError with a message meant to be
 * shown to the person who uploaded it, since the usual cause is uploading the
 * wrong file.
 */
export function parseBundle(input: unknown): ParsedBundle {
  const parsed = bundleSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new BundleError(
      "That file is not a collector snapshot.",
      first ? `${first.path.join(".") || "(root)"}: ${first.message}` : undefined
    );
  }

  const snapshot = parsed.data;

  // Checked after shape, so a v2 bundle gets "too new" rather than a pile of
  // field errors from being read against the v1 schema.
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(snapshot.schemaVersion)) {
    throw new BundleError(
      `Snapshot schema version ${snapshot.schemaVersion} is not supported.`,
      `This build reads version ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}. Re-run the collector.`
    );
  }

  return {
    provider: snapshot.provider,
    snapshot: snapshot as BundleSnapshot,
    collectorVersion: snapshot.collector.version,
    collectedAt: new Date(snapshot.collectedAt),
  };
}

/**
 * Run the same analysis the token path runs.
 *
 * This is the whole point of the split in vercel.ts / heroku.ts: there is one
 * analyzer per provider, and it does not know or care whether the snapshot
 * came from our API call or the customer's laptop.
 */
export function analyzeBundle(parsed: ParsedBundle): ConnectorAssessment {
  switch (parsed.provider) {
    case "vercel":
      return analyzeVercel(parsed.snapshot as VercelSnapshot);
    case "heroku":
      return analyzeHeroku(parsed.snapshot as HerokuSnapshot);
  }
}

/** How stale a snapshot is, in whole days. Reports show this: a fixed fee
 * quoted off a two-month-old inventory deserves a caveat. */
export function bundleAgeDays(parsed: ParsedBundle, now = new Date()): number {
  return Math.max(
    0,
    Math.floor((now.getTime() - parsed.collectedAt.getTime()) / 86_400_000)
  );
}
