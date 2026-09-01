/** Types for vercel.mjs. The .mjs stays plain JavaScript on purpose: a
 * customer runs the exact file that ships, with no build step to audit. */

export interface VercelProjectSnapshot {
  id: string | null;
  name: string | null;
  framework: string | null;
  nodeVersion: string | null;
  serverlessFunctionRegion: string | null;
  /** Length of the project's env array. Never its contents. `null` when the
   * API response carried no env array at all, which is distinct from zero. */
  envVarCount: number | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  rootDirectory: string | null;
  installCommand: string | null;
  devCommand: string | null;
  link: {
    type: string | null;
    org: string | null;
    repo: string | null;
    productionBranch: string | null;
  } | null;
}

export interface VercelDomainSnapshot {
  id: string | null;
  name: string | null;
  serviceType: string | null;
}

export interface VercelSnapshot {
  schemaVersion: number;
  provider: "vercel";
  collector: { name: string; version: string };
  collectedAt: string;
  projects: VercelProjectSnapshot[];
  domains: VercelDomainSnapshot[];
  /** False when the domains call failed, e.g. a token without domain scope.
   * Lets a report tell "no domains" apart from "could not look". */
  domainsRead: boolean;
}

export interface CollectOptions {
  token: string;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
}

export declare const SCHEMA_VERSION: number;
export declare const COLLECTOR_VERSION: string;
export declare const ENDPOINTS: { path: string; why: string }[];
export declare const FIELDS: Record<string, string[]>;

export declare function collect(options: CollectOptions): Promise<VercelSnapshot>;
export declare function pickProject(p: any): VercelProjectSnapshot;
export declare function pickDomain(d: any): VercelDomainSnapshot;
