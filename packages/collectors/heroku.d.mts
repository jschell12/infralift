/** Types for heroku.mjs. See the note in vercel.d.mts on why the collector
 * itself is plain JavaScript. */

export interface HerokuFormationSnapshot {
  type: string | null;
  size: string | null;
  quantity: number;
}

export interface HerokuAddonSnapshot {
  id: string | null;
  name: string | null;
  addonServiceName: string | null;
  planName: string | null;
  billedPriceCents: number | null;
}

export interface HerokuAppSnapshot {
  id: string | null;
  name: string | null;
  region: string | null;
  stack: string | null;
  maintenance: boolean;
  formation: HerokuFormationSnapshot[];
  /** False when the formation call failed, e.g. a collaborator-scoped key.
   * Keeps "no dynos" distinct from "could not see the dynos". */
  formationRead: boolean;
  addons: HerokuAddonSnapshot[];
  addonsRead: boolean;
}

export interface HerokuSnapshot {
  schemaVersion: number;
  provider: "heroku";
  collector: { name: string; version: string };
  collectedAt: string;
  apps: HerokuAppSnapshot[];
}

export interface CollectOptions {
  token: string;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
}

export declare const SCHEMA_VERSION: number;
export declare const COLLECTOR_VERSION: string;
export declare const ENDPOINTS: { path: string; why: string }[];
export declare const NOT_CALLED: { path: string; why: string }[];
export declare const FIELDS: Record<string, string[]>;

export declare function collect(options: CollectOptions): Promise<HerokuSnapshot>;
export declare function pickApp(a: any): Omit<
  HerokuAppSnapshot,
  "formation" | "formationRead" | "addons" | "addonsRead"
>;
export declare function pickFormation(f: any): HerokuFormationSnapshot;
export declare function pickAddon(a: any): HerokuAddonSnapshot;
