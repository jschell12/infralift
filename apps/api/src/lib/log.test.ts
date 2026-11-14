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
