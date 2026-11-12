import { Prisma } from "@prisma/client";

// Prisma's error codes for the two outcomes callers act on, by name, so a
// handler reads "a unique constraint refused this" rather than "P2002". The
// code is Prisma's contract; the message text is not, and can change with any
// release.

/** P2002: an insert or update would break a unique constraint or index. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** P2025: update or delete found no row to change. */
export function isRecordNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}
