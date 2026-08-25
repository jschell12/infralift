import type {
  AssessmentFinding,
  Provider,
  ResourceInventoryItem,
} from "@infralift/shared";

export interface ConnectorAssessment {
  inventory: ResourceInventoryItem[];
  findings: Omit<AssessmentFinding, "id">[];
  estimatedMonthlyCostCents: number | null;
  estimatedMonthlySavingsCents: number | null;
}

export interface Connector {
  provider: Provider;
  /** Verify the read-only token is valid. Never mutates provider state. */
  verify(token: string): Promise<boolean>;
  /** Inventory resources + produce findings. Read-only API calls only. */
  assess(token: string): Promise<ConnectorAssessment>;
}
