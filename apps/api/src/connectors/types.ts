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

export interface Connector {
  provider: Provider;
  /** Verify the read-only token is valid. Never mutates provider state. */
  verify(token: string): Promise<boolean>;
  /** Inventory resources + produce findings. Read-only API calls only. */
  assess(token: string): Promise<ConnectorAssessment>;
}
