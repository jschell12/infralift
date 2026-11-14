import { STACK } from "./env.js";

/** The infralift API as the dashboard calls it (dev-mode auth: one user). */
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(`${STACK.api}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
}

/** Polls `read` until `done` holds, or fails naming what it last saw. */
export async function until<T>(what: string, read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await read();
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(last).slice(0, 500)}`);
}
