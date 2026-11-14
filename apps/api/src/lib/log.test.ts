import { afterEach, describe, expect, it } from "vitest";
import { captureLogs, log, runWithRequestContext, scrubSecrets, serializeError } from "./log.js";

// A credential of each shape infralift holds. None is real; each matches the
// format the provider issues, so the scrub patterns are tested on the shape
// they will meet.
const GITHUB_TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const GITLAB_TOKEN = "glpat-" + "x9Y8z7W6v5U4t3S2r1Q0";
const ANTHROPIC_KEY = "sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz012345";
const AWS_KEY_ID = "AKIA" + "IOSFODNN7EXAMPLE";
const JWT = "eyJhbGciOiJSUzI1NiJ9" + ".eyJlbWFpbCI6ImFAYi5jIn0" + ".c2lnbmF0dXJlLXNpZ25hdHVyZQ";
const OPAQUE = "tfc-opaque-credential-7f3a9c";
// Terraform Cloud: 14 characters, ".atlasv1.", then about 67 more.
const TFC_TOKEN = "Xk3pQ9rT2vLm8w" + ".atlasv1." + "aB3dE5fG7hJ9kL1mN3pQ5rS7tV9wX1yZ3aB5cD7eF9gH1jK3lM5nP7qR9sT1uV3wX5yZ7aB9c";
// DigitalOcean: "dop_v1_" and 64 hex characters (doo_ for OAuth, dor_ for refresh).
const DO_TOKEN = "dop_v1_" + "4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a";
const DO_OAUTH = "doo_v1_" + "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
// Fly.io: older "fo1_" personal tokens, and macaroons sent as "FlyV1 fm2_...".
const FLY_TOKEN = "fo1_" + "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa98765";
const FLY_MACAROON = "fm2_" + "lJPECAAAAAAAAPpTxBDU9pK0QzUuWWgIwFMd6QK3wrVodHRwczovL2FwaS5mbHkuaW8vdjGWAJLOAAWGBR8Lk7lwcmd";
// Stripe: secret, restricted and webhook signing keys.
const STRIPE_SECRET = "sk_live_" + "51Hq2xYAbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const STRIPE_RESTRICTED = "rk_test_" + "51Hq2xYZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210";
const STRIPE_WEBHOOK = "whsec_" + "5f3c9a1e7b2d4f6a8c0e2b4d6f8a0c2e";

let logs: ReturnType<typeof captureLogs> | undefined;
afterEach(() => logs?.restore());

describe("secrets never reach the log", () => {
  it("redacts credential fields by name, at the top level and one level down", () => {
    logs = captureLogs();
    log.info({ token: OPAQUE, connection: { provider: "tfc", token: OPAQUE, secret: OPAQUE } }, "connection saved");
    log.info({ headers: { authorization: `Bearer ${OPAQUE}`, cookie: `CF_Authorization=${OPAQUE}` } }, "headers");
    log.info({ password: OPAQUE, apiKey: OPAQUE, encryptedToken: OPAQUE, credentials: { a: OPAQUE } }, "more");
    const out = logs.raw.join("\n");
    expect(out).not.toContain(OPAQUE);
    expect(out).toContain('"provider":"tfc"');
    expect(logs.lines[0]).toMatchObject({ token: "[redacted]", connection: { token: "[redacted]" } });
  });

  it("scrubs token shapes out of message text, where field names cannot help", () => {
    logs = captureLogs();
    log.error(`GitHub said 401 for Authorization: Bearer ${GITHUB_TOKEN}`);
    log.error({ detail: `gitlab ${GITLAB_TOKEN} aws ${AWS_KEY_ID}` }, `anthropic ${ANTHROPIC_KEY}`);
    log.warn({ assertion: JWT }, "access token rejected");
    const out = logs.raw.join("\n");
    for (const secret of [GITHUB_TOKEN, GITLAB_TOKEN, ANTHROPIC_KEY, AWS_KEY_ID, JWT]) expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
    expect(out).toContain("GitHub said 401");
  });

  it("scrubs Terraform Cloud, DigitalOcean, Fly.io and Stripe tokens out of message text", () => {
    const secrets = [TFC_TOKEN, DO_TOKEN, DO_OAUTH, FLY_TOKEN, FLY_MACAROON, STRIPE_SECRET, STRIPE_RESTRICTED, STRIPE_WEBHOOK];
    logs = captureLogs();
    log.error(`TFC refused ${TFC_TOKEN}; DO ${DO_TOKEN} and ${DO_OAUTH}`);
    log.error({ detail: `Authorization: FlyV1 ${FLY_MACAROON}, legacy ${FLY_TOKEN}` }, `stripe ${STRIPE_SECRET} ${STRIPE_RESTRICTED} ${STRIPE_WEBHOOK}`);
    const out = logs.raw.join("\n");
    for (const secret of secrets) expect(out).not.toContain(secret);
    expect(out).toContain("TFC refused [redacted]");
    // The prefixes alone, or one too short to be a token, are ordinary text.
    for (const text of ["dop_v1_ is the prefix", "sk_live_ keys", "fo1_short", "abc.atlasv1.def", "whsec_123"]) expect(scrubSecrets(text)).toBe(text);
  });

  it("logs an error as name, message, stack and status, never its other fields", () => {
    logs = captureLogs();
    // body-parser attaches the raw request text to its errors as `body`.
    const err = Object.assign(new Error("unexpected end of JSON"), { body: `{"token":"${OPAQUE}"`, status: 400 });
    log.error({ err }, "parse failed");
    expect(logs.raw.join("\n")).not.toContain(OPAQUE);
    expect(logs.lines[0].err).toMatchObject({ type: "Error", message: "unexpected end of JSON", status: 400 });
    expect(serializeError("plain")).toEqual({ message: "plain" });
  });

  it("leaves ordinary text alone: ids, hashes and timestamps", () => {
    const text = "job cm3x9a2b0000 commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b at 2026-11-14T12:00:00Z";
    expect(scrubSecrets(text)).toBe(text);
  });
});

describe("request context on every line", () => {
  it("adds the request id, org and user to lines written inside a request, and nothing outside one", () => {
    logs = captureLogs();
    runWithRequestContext({ requestId: "req-12345678", orgId: "org-a", userId: "user-1" }, () => log.info("inside"));
    log.info("outside");
    expect(logs.lines[0]).toMatchObject({ requestId: "req-12345678", orgId: "org-a", userId: "user-1", msg: "inside" });
    expect(logs.lines[1].requestId).toBeUndefined();
    expect(logs.lines[1]).toMatchObject({ level: "info", service: "infralift-api" });
  });
});
