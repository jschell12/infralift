import { describe, expect, it, vi } from "vitest";
import { deliverChangeRequest, type DeliveryRequest } from "./deliver.js";
import type { GitHostClient } from "./hosts.js";

// The delivery step on its own, against a fake host client: the order of
// calls, and what is left in the repository when something fails.

function fakeClient(opts: { existing?: { url: string; branch: string }; noop?: boolean; commitFails?: boolean } = {}) {
  const calls: string[] = [];
  const client = {
    findOpenChangeRequest: vi.fn(async () => {
      calls.push("find");
      return opts.existing ?? null;
    }),
    createBranch: vi.fn(async ({ branch }: { branch: string }) => void calls.push(`branch ${branch}`)),
    deleteBranch: vi.fn(async ({ branch }: { branch: string }) => void calls.push(`delete ${branch}`)),
    commitFiles: vi.fn(async ({ branch }: { branch: string }) => {
      calls.push(`commit ${branch}`);
      if (opts.commitFails) throw new Error("boom");
      return opts.noop ? { commitSha: null, noop: true } : { commitSha: "c1", noop: false };
    }),
    openChangeRequest: vi.fn(async () => {
      calls.push("open");
      return { url: "https://x/pull/1" };
    }),
  } as unknown as GitHostClient;
  return { client, calls };
}

const req = (over: Partial<DeliveryRequest> = {}): DeliveryRequest => ({
  repo: "acme/app",
  base: "main",
  isMine: () => true,
  newBranch: "infralift/acme-12345678",
  files: async () => [{ fileName: "a.tf", content: "x" }],
  workDir: "",
  message: "m",
  title: "t",
  body: () => "b",
  ...over,
});

describe("deliverChangeRequest", () => {
  it("branches, commits and opens a request", async () => {
    const { client, calls } = fakeClient();
    const out = await deliverChangeRequest(client, req());
    expect(out).toMatchObject({ outcome: "opened", url: "https://x/pull/1", commitSha: "c1" });
    expect(calls).toEqual(["find", "branch infralift/acme-12345678", "commit infralift/acme-12345678", "open"]);
  });

  it("commits onto this project's open request instead of opening another", async () => {
    const { client, calls } = fakeClient({ existing: { url: "https://x/pull/9", branch: "infralift/acme-aaaaaaaa" } });
    const out = await deliverChangeRequest(client, req());
    expect(out).toMatchObject({ outcome: "updated", url: "https://x/pull/9" });
    expect(calls).toEqual(["find", "commit infralift/acme-aaaaaaaa"]);
  });

  it("removes a branch it created when nothing changed", async () => {
    const { client, calls } = fakeClient({ noop: true });
    expect((await deliverChangeRequest(client, req())).outcome).toBe("unchanged");
    expect(calls.at(-1)).toBe("delete infralift/acme-12345678");
  });

  it("removes a branch it created when the commit fails, and rethrows", async () => {
    const { client, calls } = fakeClient({ commitFails: true });
    await expect(deliverChangeRequest(client, req())).rejects.toThrow("boom");
    expect(calls.at(-1)).toBe("delete infralift/acme-12345678");
  });

  it("creates no branch when building the files fails", async () => {
    const { client, calls } = fakeClient();
    await expect(deliverChangeRequest(client, req({ files: async () => Promise.reject(new Error("render")) }))).rejects.toThrow("render");
    expect(calls).toEqual(["find"]);
  });

  it("never deletes a branch that belongs to an existing request", async () => {
    const { client, calls } = fakeClient({ existing: { url: "u", branch: "infralift/acme-aaaaaaaa" }, commitFails: true });
    await expect(deliverChangeRequest(client, req())).rejects.toThrow("boom");
    expect(calls.some((c) => c.startsWith("delete"))).toBe(false);
  });
});
