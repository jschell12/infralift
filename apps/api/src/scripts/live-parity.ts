/**
 * Live parity check: run both intake paths against a real account and diff.
 *
 * The unit test in connectors/bundle-parity.test.ts proves parity over
 * recorded fixtures. This proves it against whatever the provider is actually
 * returning today, which is the half a fixture cannot cover: an API that
 * changed shape breaks both paths here at the same time, loudly, instead of
 * being discovered when a customer's quote comes out wrong.
 *
 * Not part of `pnpm test` — it needs credentials and network.
 *
 *   VERCEL_TOKEN=... HEROKU_API_KEY=... pnpm --filter @infralift/api exec \
 *     tsx src/scripts/live-parity.ts
 *
 * Tokens come from scredmgr in this repo's environment:
 *   infralift-e2e/VERCEL_TOKEN, infralift-e2e/HEROKU_API_KEY
 */

import { collect as collectVercel } from "@infralift/collectors/vercel";
import { collect as collectHeroku } from "@infralift/collectors/heroku";
import { vercelConnector } from "../connectors/vercel.js";
import { herokuConnector } from "../connectors/heroku.js";
import { parseBundle, analyzeBundle } from "../connectors/bundle.js";

type Collect = (opts: { token: string }) => Promise<unknown>;

async function checkProvider(
  label: string,
  token: string | undefined,
  assess: (token: string) => Promise<unknown>,
  collect: Collect
): Promise<boolean> {
  if (!token) {
    console.log(`- ${label}: skipped, no token in env`);
    return true;
  }

  const viaToken = await assess(token);

  // Round-trip through JSON exactly as an uploaded file would.
  const snapshot = JSON.parse(JSON.stringify(await collect({ token })));
  const viaBundle = analyzeBundle(parseBundle(snapshot));

  const a = JSON.stringify(viaToken, null, 1);
  const b = JSON.stringify(viaBundle, null, 1);

  if (a === b) {
    const n = (viaToken as { inventory: unknown[] }).inventory.length;
    console.log(`- ${label}: match (${n} inventory items)`);
    return true;
  }

  console.error(`- ${label}: MISMATCH`);
  const al = a.split("\n");
  const bl = b.split("\n");
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) {
      console.error(`    line ${i + 1}`);
      console.error(`      token:  ${al[i] ?? "(end)"}`);
      console.error(`      bundle: ${bl[i] ?? "(end)"}`);
      break;
    }
  }
  return false;
}

const results = await Promise.all([
  checkProvider(
    "vercel",
    process.env.VERCEL_TOKEN,
    (t) => vercelConnector.assess(t),
    collectVercel as Collect
  ),
  checkProvider(
    "heroku",
    process.env.HEROKU_API_KEY,
    (t) => herokuConnector.assess(t),
    collectHeroku as Collect
  ),
]);

if (results.every(Boolean)) {
  console.log("\nToken path and bundle path agree.");
} else {
  console.error("\nPaths disagree. A customer-run collection would not match.");
  process.exit(1);
}
