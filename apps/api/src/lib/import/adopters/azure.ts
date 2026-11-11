import type { Adopter } from "./types.js";
import { tfName } from "./types.js";

// azurerm imports by the full ARM resource id, which the connector stores.
const TYPES: Record<string, string> = {
  "azure:storage_account": "azurerm_storage_account",
  "azure:app_service_plan": "azurerm_service_plan",
  "azure:sql_server": "azurerm_mssql_server",
  "azure:sql_database": "azurerm_mssql_database",
};

export const azureAdopter: Adopter = {
  provider: "azure",
  map(item) {
    const t = TYPES[item.type];
    return t && item.externalId.startsWith("/subscriptions/") ? { to: `${t}.${tfName(item.name)}`, id: item.externalId } : null;
  },
  // azurerm refuses to configure without a features block, even an empty one.
  defaultBody: "features",
};
