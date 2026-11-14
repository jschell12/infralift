// ---------------------------------------------------------------------------
// Fan-out with a ceiling on how many calls are in flight.
//
// Connectors that make one provider call per item (Netlify forms per site,
// Cloud Run services per region) use this, so an account with a hundred sites
// makes four requests at a time rather than a hundred at once, which is what
// a provider's rate limiter answers with 429s. Each call keeps its own
// deadline through httpFetch (lib/http.ts); this only bounds how many run.
//
// Worker pool pattern: `limit` workers pull the next index from a shared
// counter until the list is used up.
// ---------------------------------------------------------------------------

/** The outcome of one item: its result, or the error its call threw. */
export type Settled<R> = { ok: true; value: R } | { ok: false; error: unknown };

/** Runs `fn` over `items`, at most `limit` at a time, and returns every
 *  outcome in the order of `items`. One item failing does not stop the
 *  others; the caller decides what a failure means. */
export async function settleBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<Settled<R>[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`limit must be a positive integer, not ${limit}`);
  const results: Settled<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { ok: true, value: await fn(items[index]!) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
