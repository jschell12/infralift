import type { GeneratedFile } from "./codegen.js";

// What a locked org gets back from codegen.
//
// The goal is a sample that lets someone judge the workmanship without
// handing them the work. Those pull in opposite directions, so the split is
// deliberate rather than "first N lines of everything":
//
//   README.md    in full. It is the human-readable plan — what the target
//                replaces and, more usefully, what it does NOT replace. It is
//                the single best argument for the fee and it applies nothing.
//   versions.tf  in full. Pinned provider versions are the visible edge of the
//                part that is genuinely hard (four provider-schema bugs in one
//                session were only caught by running tofu validate across
//                twelve fixture-target combinations). Alone it builds nothing.
//   target-*.tf  first few lines, so the HCL style and resource shape are
//                legible. The body is where the migration actually lives.
//
// Everything else is withheld by name and size, which still communicates
// scope: "9 files, 480 lines" reads as real work rather than a stub.

/** Files a locked caller receives complete. */
const FULL = new Set(["README.md", "versions.tf"]);

/** Files a locked caller receives truncated, and to how many lines. */
const EXCERPT_PREFIX = "target-";
const EXCERPT_LINES = 15;

export interface WithheldFile {
  fileName: string;
  lineCount: number;
}

export interface CodegenSample {
  locked: true;
  /** Readable content: the full samples plus any truncated excerpt. */
  files: GeneratedFile[];
  /** Names and sizes only. */
  withheld: WithheldFile[];
  message: string;
}

function lineCount(content: string): number {
  return content === "" ? 0 : content.split("\n").length;
}

/**
 * Reduce generated files to the sample a locked org may see.
 *
 * Pure and total: it never throws and never returns a file that was not in the
 * input, so a codegen change cannot accidentally widen what leaks.
 */
export function toCodegenSample(files: GeneratedFile[]): CodegenSample {
  const shown: GeneratedFile[] = [];
  const withheld: WithheldFile[] = [];

  for (const file of files) {
    if (FULL.has(file.fileName)) {
      shown.push(file);
      continue;
    }

    if (file.fileName.startsWith(EXCERPT_PREFIX)) {
      const lines = file.content.split("\n");
      if (lines.length <= EXCERPT_LINES) {
        // Short enough that an excerpt would be the whole file. Withhold it
        // rather than quietly handing it over.
        withheld.push({ fileName: file.fileName, lineCount: lines.length });
        continue;
      }
      const hidden = lines.length - EXCERPT_LINES;
      shown.push({
        fileName: file.fileName,
        content: `${lines.slice(0, EXCERPT_LINES).join("\n")}\n\n# ... ${hidden} more lines in the full configuration.\n`,
      });
      continue;
    }

    withheld.push({ fileName: file.fileName, lineCount: lineCount(file.content) });
  }

  const totalLines = files.reduce((n, f) => n + lineCount(f.content), 0);

  return {
    locked: true,
    files: shown,
    withheld,
    message:
      `Sample of ${files.length} files, ${totalLines} lines. The assessment, the cost comparison and the ranked targets are yours to keep. ` +
      `The applyable configuration is part of the migration.`,
  };
}
