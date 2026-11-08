import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Conflict, InvalidBody, InvalidInput, NotFound, Upstream, handle, parseBody } from "./errors.js";
import { GitCommitError } from "./git/errors.js";

function fakeRes() {
  const out = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(payload: unknown) {
      out.body = payload;
      return this;
    },
  };
  return { out, res };
}

describe("handle", () => {
  it("turns each AppError into its status and body", async () => {
    const cases: [Error, number, unknown][] = [
      [new InvalidInput("bad", { configFiles: ["a"] }), 400, { error: "bad", configFiles: ["a"] }],
      [new NotFound("missing"), 404, { error: "missing" }],
      [new Conflict("taken"), 409, { error: "taken" }],
      [new Upstream("github said 403", { last: null }), 502, { error: "github said 403", last: null }],
      [new GitCommitError("GitHub ref lookup failed (500)"), 502, { error: "GitHub ref lookup failed (500)" }],
    ];
    for (const [err, status, body] of cases) {
      const { out, res } = fakeRes();
      await handle(async () => {
        throw err;
      })({} as never, res as never);
      expect([out.status, out.body]).toEqual([status, body]);
    }
  });

  it("leaves any other error to the app's error handler", async () => {
    const { res } = fakeRes();
    await expect(
      handle(async () => {
        throw new Error("bug");
      })({} as never, res as never)
    ).rejects.toThrow("bug");
  });
});

describe("parseBody", () => {
  it("returns the data, or throws InvalidBody with zod's flattened errors as `error`", () => {
    const schema = z.object({ name: z.string() });
    expect(parseBody(schema, { name: "x" })).toEqual({ name: "x" });
    try {
      parseBody(schema, {});
      throw new Error("no throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidBody);
      expect((err as InvalidBody).status).toBe(400);
      expect((err as InvalidBody).body().error).toMatchObject({ fieldErrors: { name: expect.any(Array) } });
    }
  });
});
