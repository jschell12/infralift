import { parentPort } from "node:worker_threads";
import { TfInputValidationError } from "../tf/render.js";
import { memoryTree, newSchemaCompiler, renderStack, type StackFile, type StackManifest } from "./index.js";

// The thread a team stack's trial render runs in (lib/stacks/team.ts,
// ADR 0009). Compiling and validating a team's own input schema, and
// rendering its templates, can take time exponential in what the team wrote;
// here that blocks this thread, which the API terminates on a timeout, and
// never the API's event loop.
//
// Protocol: post "ready" once loaded, take one job, post one result.

export interface RenderJob {
  manifest: StackManifest;
  contents: Record<string, { content: string; mode: StackFile["mode"] }>;
}
export type RenderResult = { ok: true; renderedFiles: number } | { ok: false; error: string };

const port = parentPort!;
port.once("message", (job: RenderJob) => {
  let result: RenderResult;
  try {
    const tree = memoryTree(new Map(Object.entries(job.contents)));
    // A compiler of its own: a team schema's $id cannot collide with another
    // org's, and nothing it compiles outlives this thread.
    const files = renderStack(job.manifest, job.manifest.example, tree, newSchemaCompiler());
    result = { ok: true, renderedFiles: files.length };
  } catch (err) {
    const why = err instanceof TfInputValidationError ? err.message : `does not render: ${(err as Error).message}`;
    result = { ok: false, error: `example ${why}` };
  }
  port.postMessage(result);
});
port.postMessage("ready");
