import { Ajv2020 as Ajv } from "ajv/dist/2020.js";

// ---------------------------------------------------------------------------
// Terraform template rendering.
//
// Template syntax (TS-native, no Jinja):
//   {{name}}                  -> interpolate input value
//   {{#if name}} ... {{/if}}  -> emit block only when input `name` was provided
//
// Inputs are validated against the template version's JSON Schema before
// rendering, so a rendered file can only contain values the schema allows.
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });

export class TfInputValidationError extends Error {
  details: string[];
  constructor(details: string[]) {
    super(`invalid template inputs: ${details.join("; ")}`);
    this.details = details;
  }
}

export type TfArguments = Record<string, string | number | boolean>;

export function validateArguments(
  inputSchema: object,
  args: TfArguments
): void {
  const validate = ajv.compile(inputSchema);
  if (!validate(args)) {
    const details = (validate.errors ?? []).map(
      (e) => `${e.instancePath || "(root)"} ${e.message ?? "invalid"}`
    );
    throw new TfInputValidationError(details);
  }
}

const IF_BLOCK = /\{\{#if\s+([A-Za-z_][A-Za-z0-9_]*)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g;
const VAR = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function renderTemplate(
  templateBody: string,
  args: TfArguments
): string {
  // Conditional blocks first: drop the block entirely when the input is
  // absent, keep (and strip markers from) it when present.
  const withBlocks = templateBody.replace(IF_BLOCK, (_m, name, body) =>
    args[name] === undefined ? "" : body
  );
  const rendered = withBlocks.replace(VAR, (_m, name) => {
    const v = args[name];
    if (v === undefined) {
      throw new TfInputValidationError([`missing value for {{${name}}}`]);
    }
    return String(v);
  });
  // Collapse runs of 3+ newlines left behind by removed blocks.
  return rendered.replace(/\n{3,}/g, "\n\n");
}

// Rendered file naming convention: one file per job, prefixed by project so
// a shared destination directory stays collision-free.
export function renderedFileName(projectName: string, jobId: string): string {
  return `${projectName}-job-${jobId}.tf`;
}

export interface ProviderConfig {
  name: string; // e.g. "aws"
  source: string; // e.g. "hashicorp/aws"
  version: string; // e.g. "~> 5.0"
  region?: string;
}

export function renderProviderFile(cfg: ProviderConfig): string {
  const lines = [
    `provider "${cfg.name}" {`,
    ...(cfg.region ? [`  region = "${cfg.region}"`] : []),
    `}`,
    ``,
    `terraform {`,
    `  required_providers {`,
    `    ${cfg.name} = {`,
    `      source  = "${cfg.source}"`,
    `      version = "${cfg.version}"`,
    `    }`,
    `  }`,
    `}`,
    ``,
  ];
  return lines.join("\n");
}
