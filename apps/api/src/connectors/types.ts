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

/** What a verify call learned beyond yes or no. */
export interface VerifyResult {
  valid: boolean;
  /** Why it is not valid, short and free of secrets; null when valid. */
  reason: string | null;
  /** When the provider says the credential expires, if it said. */
  expiresAt: Date | null;
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
  assess(token: string): Promise<ConnectorAssessment>;
}
