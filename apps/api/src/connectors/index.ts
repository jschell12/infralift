import type { Provider } from "@infralift/shared";
import { runtimeEndpoints, type Endpoints } from "../lib/endpoints.js";
import type { Connector } from "./types.js";
import { createVercelConnector } from "./vercel.js";
import { createCloudflareConnector } from "./cloudflare.js";
import { createHerokuConnector } from "./heroku.js";
import { awsSdkClients, createAwsConnector } from "./aws.js";
import { createFirebaseConnector } from "./firebase.js";
import { createGithubConnector } from "./github.js";
import { createGitlabConnector } from "./gitlab.js";
import { createNetlifyConnector } from "./netlify.js";
import { createRenderConnector } from "./render.js";
import { createRailwayConnector } from "./railway.js";
import { createFlyioConnector } from "./flyio.js";
import { createDigitaloceanConnector } from "./digitalocean.js";
import { createGcpConnector } from "./gcp.js";
import { createAzureConnector } from "./azure.js";

// Strategy + registry: one connector per provider, each built against the
// endpoints it is given (lib/endpoints.ts), so a test or the e2e stack can
// point every provider somewhere other than the real API.

export type ConnectorRegistry = Record<Provider, Connector>;

export function createConnectorRegistry(endpoints: Endpoints): ConnectorRegistry {
  return {
    vercel: createVercelConnector(endpoints),
    cloudflare: createCloudflareConnector(endpoints),
    heroku: createHerokuConnector(endpoints),
    aws: createAwsConnector(awsSdkClients(endpoints)),
    firebase: createFirebaseConnector(endpoints),
    github: createGithubConnector(endpoints),
    gitlab: createGitlabConnector(endpoints),
    netlify: createNetlifyConnector(endpoints),
    render: createRenderConnector(endpoints),
    railway: createRailwayConnector(endpoints),
    flyio: createFlyioConnector(endpoints),
    digitalocean: createDigitaloceanConnector(endpoints),
    gcp: createGcpConnector(endpoints),
    azure: createAzureConnector(endpoints),
  };
}

let runtimeRegistry: ConnectorRegistry | null = null;

/** The connector for `provider`, built against this process's endpoints
 *  (runtimeEndpoints(): the real APIs unless INFRALIFT_ENDPOINT_* is set). */
export function getConnector(provider: Provider): Connector {
  runtimeRegistry ??= createConnectorRegistry(runtimeEndpoints());
  return runtimeRegistry[provider];
}

export type { Connector, ConnectorAssessment } from "./types.js";
