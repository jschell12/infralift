import type {
  AssessmentFinding,
  Provider,
  ResourceInventoryItem,
} from "@infralift/shared";

export interface ConnectorAssessment {
  inventory: ResourceInventoryItem[];
  findings: Omit<AssessmentFinding, "id">[];
  estimatedMonthlyCostCents: number | null;
  // No savings figure: connectors used to subtract a flat $20 VPS from the
  // bill, which contradicted the sized comparison. Savings are computed from
  // the inventory by buildMigrationOptions() (services/assessments.ts).
}

/** A provider answered with an HTTP error. The message names the path and
 *  status, never the token or the response body, and `status` lets a caller
 *  tell a refused credential (401/403) from an outage (5xx). The collectors
 *  package throws plain Errors carrying the same `status` field. */
export class ProviderHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** The stored credential is not the kind this provider takes (a Firebase
 *  connection whose secret is not a service account JSON key). Thrown before
 *  any call to the provider, so it can never work as it is: replacing it is
 *  the only fix. `expected` is what it should be, in words a customer reads
 *  ("a service account key"); the message is for the log. Neither quotes the
 *  credential. */
export class CredentialFormatError extends Error {
  constructor(
    message: string,
    readonly expected: string
  ) {
    super(message);
  }
}

/** What a verify call learned beyond yes or no. */
export interface VerifyResult {
  valid: boolean;
  /** Why it is not valid, short and free of secrets; null when valid. */
  reason: string | null;
  /** When the provider says the credential expires, if it said. */
  expiresAt: Date | null;
  /** The provider did not answer in time, so nothing was learned about the
   *  credential. A caller keeps the connection's status as it was. */
  timedOut?: boolean;
}

/** What an assess() call should fetch. Cost data can be a metered call (AWS
 *  Cost Explorer bills per request), and a caller that only needs the
 *  inventory, such as the unmanaged view, asks for none. Connectors whose
 *  cost data is free, or comes with the inventory, ignore it. */
export interface AssessOptions {
  /** Default true. False: no cost calls; estimatedMonthlyCostCents is null. */
  costs?: boolean;
}

export interface Connector {
  provider: Provider;
  /** Verify the read-only token is valid. Never mutates provider state. */
  verify(token: string): Promise<boolean>;
  /** The same call as verify(), with the reason and expiry the provider
   *  reported. Optional: connectors without it are verify() plus a generic
   *  reason. */
  check?(token: string): Promise<VerifyResult>;
  /** Inventory resources + produce findings. Read-only API calls only. */
  assess(token: string, opts?: AssessOptions): Promise<ConnectorAssessment>;
}
