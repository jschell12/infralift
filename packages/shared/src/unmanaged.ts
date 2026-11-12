// Types for "Adopt from an account" (ADR 0010): what a connection's account
// holds that no infralift project manages, and adopting a selection of it.
// Produced by the API (apps/api/src/services/unmanaged.ts), shown by the
// dashboard's new-project page.

import type { Provider } from "./index.js";

/** One resource in the account that no project manages or has reserved. */
export interface UnmanagedResource {
  /** The connector's inventory type, e.g. "aws:ec2:instance". With
   *  providerId, the key to send back when adopting. */
  type: string;
  /** The provider's own id for it (an ARN on AWS, a zone id on Cloudflare). */
  providerId: string;
  name: string;
  region: string | null;
  /** Whether infralift can write an import block for it today. */
  adoptable: boolean;
  /** Why not, when it cannot. */
  reason: string | null;
  /** The Terraform resource type it would be imported as, when it can. */
  terraformType: string | null;
}

/** GET /connections/:id/unmanaged. The next page's cursor is in the
 *  X-Next-Cursor header, absent on the last page; send it back as ?cursor=.
 *  ?refresh=1 reads the account again instead of the cached inventory. */
export interface UnmanagedPage {
  connectionId: string;
  provider: Provider;
  /** When the inventory this page is cut from was read from the provider. */
  fetchedAt: string;
  /** Unmanaged resources in the whole inventory, not this page. */
  total: number;
  /** How many of those can be adopted today. */
  adoptable: number;
  resources: UnmanagedResource[];
  /** What the inventory already says about the state backend, so the adopt
   *  form can fill it in rather than ask. Absent from older API versions. */
  backendDefaults?: AdoptBackendDefaults;
}

/** A Cloudflare account the connection's token can see, as the inventory
 *  records it on the account's resources. */
export interface CloudflareAccountRef {
  id: string;
  /** The account's name in Cloudflare, when the inventory has it. */
  name: string | null;
}

export interface AdoptBackendDefaults {
  /** Cloudflare connections: the accounts the inventory found resources in,
   *  by name. An R2 backend's account id is one of these unless the bucket
   *  lives elsewhere. Empty for other providers. */
  cloudflareAccounts: CloudflareAccountRef[];
  /** AWS connections: the region most of the account's regional resources are
   *  in, as a starting value for an S3 backend's region. Null otherwise. */
  awsRegion: string | null;
}

/** POST /connections/:id/adopt. `resources` are keys from the unmanaged list.
 *  A new project needs a name, a GitHub repository, a directory in it and a
 *  state backend; an existing project must manage the same account and is
 *  refused for now (409), because its import check does not generate code for
 *  imports added after the first. */
export interface AdoptSelectedRequest {
  resources: { type: string; providerId: string }[];
  target:
    | {
        kind: "new";
        name: string;
        repo: string;
        ref?: string;
        gitConnectionId?: string;
        path: string;
        /** An r2 backend without accountId gets the connection's Cloudflare
         *  account when the inventory found exactly one. */
        backend: { kind: "s3" | "r2"; bucket: string; key: string; region?: string; accountId?: string };
      }
    | { kind: "existing"; projectId: string };
}

/** 202 with the new project and its import job; 200 with `replayed: true`
 *  when the same request was already accepted. */
export interface AdoptSelectedResult {
  projectId: string;
  projectName: string;
  jobId: string | null;
  jobStatus: string | null;
  adopted: number;
  replayed?: boolean;
}
