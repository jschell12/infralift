// The Azure subscription Prism serves (sources.ts "azure"). Only the fields
// connectors/azure.ts reads, plus what makes a record recognizable;
// extract.ts fills the rest from the response schema and checks the example
// against it. Resource ids are ARM ids under the seeded subscription, which
// is what the connector follows to list a SQL server's databases.

export const AZURE_SEED = {
  tenantId: "e2e0a0a0-0000-4000-8000-000000000400",
  subscriptionId: "e2e0a0a0-0000-4000-8000-000000000401",
  resourceGroup: "infralift-e2e",
} as const;

const rg = `/subscriptions/${AZURE_SEED.subscriptionId}/resourceGroups/${AZURE_SEED.resourceGroup}/providers`;

export const AZURE_IDS = {
  site: `${rg}/Microsoft.Web/sites/infralift-e2e-web`,
  plan: `${rg}/Microsoft.Web/serverfarms/infralift-e2e-plan`,
  vm: `${rg}/Microsoft.Compute/virtualMachines/infralift-e2e-vm`,
  sqlServer: `${rg}/Microsoft.Sql/servers/infralift-e2e-sql`,
  sqlDatabase: `${rg}/Microsoft.Sql/servers/infralift-e2e-sql/databases/appdb`,
  storage: `${rg}/Microsoft.Storage/storageAccounts/infraliftee2e`,
} as const;

const list = (value: unknown[]) => ({ value });

export const AZURE_EXAMPLES: Record<string, unknown> = {
  "/subscriptions/{subscriptionId}/providers/Microsoft.Web/sites": list([
    {
      id: AZURE_IDS.site,
      name: "infralift-e2e-web",
      location: "eastus",
      kind: "app,linux",
      properties: { state: "Running", defaultHostName: "infralift-e2e-web.azurewebsites.net", httpsOnly: true, siteConfig: { linuxFxVersion: "NODE|22-lts" } },
    },
  ]),
  "/subscriptions/{subscriptionId}/providers/Microsoft.Web/serverfarms": list([
    { id: AZURE_IDS.plan, name: "infralift-e2e-plan", location: "eastus", kind: "linux", sku: { name: "B1", tier: "Basic", capacity: 1 } },
  ]),
  "/subscriptions/{subscriptionId}/providers/Microsoft.Compute/virtualMachines": list([
    {
      id: AZURE_IDS.vm,
      name: "infralift-e2e-vm",
      location: "eastus",
      properties: { hardwareProfile: { vmSize: "Standard_B1s" }, storageProfile: { osDisk: { osType: "Linux", createOption: "FromImage" } } },
    },
  ]),
  "/subscriptions/{subscriptionId}/providers/Microsoft.Sql/servers": list([
    { id: AZURE_IDS.sqlServer, name: "infralift-e2e-sql", location: "eastus", properties: { version: "12.0" } },
  ]),
  "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Sql/servers/{serverName}/databases": list([
    { id: AZURE_IDS.sqlDatabase, name: "appdb", location: "eastus", sku: { name: "Basic", tier: "Basic" }, properties: { maxSizeBytes: 2147483648 } },
  ]),
  "/subscriptions/{subscriptionId}/providers/Microsoft.Storage/storageAccounts": list([
    { id: AZURE_IDS.storage, name: "infraliftee2e", location: "eastus", kind: "StorageV2", sku: { name: "Standard_LRS" } },
  ]),
};
