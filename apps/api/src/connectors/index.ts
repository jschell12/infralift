import type { Provider } from "@infralift/shared";
import type { Connector } from "./types.js";
import { vercelConnector } from "./vercel.js";
import { cloudflareConnector } from "./cloudflare.js";
import { herokuConnector } from "./heroku.js";
import { awsConnector } from "./aws.js";
import { firebaseConnector } from "./firebase.js";
import { githubConnector } from "./github.js";

const connectors: Record<Provider, Connector> = {
  vercel: vercelConnector,
  cloudflare: cloudflareConnector,
  heroku: herokuConnector,
  aws: awsConnector,
  firebase: firebaseConnector,
  github: githubConnector,
};

export function getConnector(provider: Provider): Connector {
  return connectors[provider];
}

export type { Connector, ConnectorAssessment } from "./types.js";
