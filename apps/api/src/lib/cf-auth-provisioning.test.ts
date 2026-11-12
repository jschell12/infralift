import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// First sign-in provisioning (getOrCreateUser). The dashboard's first load
// sends several requests at once, and each finds no user yet.
//
// Prisma is an in-memory fake that behaves like Postgres where it matters:
// User.email is unique, an insert holds its key from the moment it is made
// (so a racing insert of the same email fails rather than both succeeding),
// and a transaction's writes are kept only if its callback returns.

type Org = { id: string; name: string };
type User = { id: string; email: string; name: string | null; orgId: string; createdAt: Date };

const db = vi.hoisted(() => ({ orgs: [] as Org[], users: [] as User[], inFlightEmails: new Set<string>(), seq: 0 }));

const dup = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`email`)", { code: "P2002", clientVersion: "test" });
const tick = () => new Promise((r) => setTimeout(r, 0));

vi.mock("./db.js", () => {
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { email: string } }) => {
        await tick();
        return db.users.find((u) => u.email === where.email) ?? null;
      },
      findUniqueOrThrow: async ({ where }: { where: { email: string } }) => {
        const u = db.users.find((x) => x.email === where.email);
        if (!u) throw new Error("not found");
        return u;
      },
      findFirst: async ({ where }: { where: { email: { equals: string; mode: string } } }) => {
        await tick();
        return db.users.find((u) => u.email.toLowerCase() === where.email.equals.toLowerCase()) ?? null;
      },
      update: async () => {
        throw new Error("not used");
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const staged = { orgs: [] as Org[], users: [] as User[] };
      const tx = {
        org: {
          create: async ({ data }: { data: { name: string } }) => {
            await tick();
            const org = { id: `org${++db.seq}`, ...data };
            staged.orgs.push(org);
            return org;
          },
        },
        user: {
          create: async ({ data }: { data: Omit<User, "id" | "createdAt"> }) => {
            await tick();
            if (db.users.some((u) => u.email === data.email) || db.inFlightEmails.has(data.email)) throw dup();
            db.inFlightEmails.add(data.email);
            const user = { id: `user${++db.seq}`, createdAt: new Date(), ...data };
            staged.users.push(user);
            return user;
          },
        },
      };
      try {
        const out = await fn(tx);
        db.orgs.push(...staged.orgs);
        db.users.push(...staged.users);
        return out;
      } finally {
        for (const u of staged.users) db.inFlightEmails.delete(u.email);
      }
    },
  };
  return { prisma };
});

const { getOrCreateUser, normalizeEmail } = await import("./cf-auth.js");

beforeEach(() => {
  db.orgs = [];
  db.users = [];
  db.inFlightEmails.clear();
  db.seq = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("getOrCreateUser", () => {
  it("gives a first sign-in arriving as five parallel requests one user and one org", async () => {
    const users = await Promise.all(
      ["ann@acme.dev", "Ann@acme.dev", " ann@ACME.dev ", "ann@acme.dev", "ANN@acme.dev"].map((e) => getOrCreateUser(e, "Ann"))
    );
    expect(db.orgs).toHaveLength(1);
    expect(db.users).toHaveLength(1);
    expect(new Set(users.map((u) => u.orgId))).toEqual(new Set([db.orgs[0]!.id]));
    expect(users.every((u) => u.email === "ann@acme.dev")).toBe(true);
  });

  it("stores the email trimmed and lowercased", async () => {
    const user = await getOrCreateUser("  Bo@Example.COM ", null);
    expect(user.email).toBe("bo@example.com");
    expect(db.users[0]!.email).toBe("bo@example.com");
  });

  it("finds a user stored in mixed case before emails were normalized, rather than provisioning a second org", async () => {
    db.orgs.push({ id: "org-legacy", name: "Cy's workspace" });
    db.users.push({ id: "user-legacy", email: "Cy@Example.com", name: "Cy", orgId: "org-legacy", createdAt: new Date(0) });
    const user = await getOrCreateUser("cy@example.com", "Cy");
    expect(user).toMatchObject({ userId: "user-legacy", orgId: "org-legacy" });
    expect(db.orgs).toHaveLength(1);
  });

  it("keeps two different people in two orgs", async () => {
    const [a, b] = await Promise.all([getOrCreateUser("a@x.dev", null), getOrCreateUser("b@x.dev", null)]);
    expect(a.orgId).not.toBe(b.orgId);
    expect(db.orgs).toHaveLength(2);
  });
});

describe("normalizeEmail", () => {
  it.each([
    ["Ann@Acme.dev", "ann@acme.dev"],
    ["  ann@acme.dev\t", "ann@acme.dev"],
    ["ann@acme.dev", "ann@acme.dev"],
  ])("%j becomes %j", (raw, normalized) => {
    expect(normalizeEmail(raw)).toBe(normalized);
  });
});
