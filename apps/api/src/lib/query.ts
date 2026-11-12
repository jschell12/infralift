import { InvalidInput } from "./errors.js";

/**
 * A whole-number query parameter, or 400. Absent or empty gives `fallback`;
 * anything else must be an integer in [min, max]. A bare Number() would turn
 * "abc" into NaN, and NaN days becomes an Invalid Date that Prisma rejects
 * with a 500.
 */
export function intQuery(
  value: unknown,
  rule: { name: string; fallback: number; min: number; max: number }
): number {
  if (value === undefined || value === "") return rule.fallback;
  const n = typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < rule.min || n > rule.max) {
    throw new InvalidInput(`${rule.name} must be a whole number from ${rule.min} to ${rule.max}`);
  }
  return n;
}
