// Smoke test for the TF generation subsystem. Run against an ephemeral
// Postgres (see PR notes); requires DATABASE_URL + seeded templates.
import { prisma } from "../src/lib/db.js";
import {
  renderTemplate,
  validateArguments,
  renderedFileName,
  renderProviderFile,
  TfInputValidationError,
} from "../src/lib/tf/render.js";
import { runJob } from "../src/lib/tf/pipeline.js";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  console.log(`ok: ${msg}`);
}

const templates = await prisma.tfTemplate.findMany({
  include: { versions: true },
});
assert(templates.length === 3, `3 seeded templates (got ${templates.length})`);

const hc = templates.find((t) => t.slug === "route53-healthcheck")!;
const hcv = hc.versions[0];

// Valid render
const args = {
  resource_name: "api_primary",
  fqdn: "api.example.com",
  resource_path: "/health",
};
validateArguments(hcv.inputSchema as object, args);
const body = renderTemplate(hcv.templateBody, args);
assert(body.includes(`fqdn              = "api.example.com"`), "fqdn interpolated");
assert(body.includes(`output "api_primary_healthcheck_id"`), "output block rendered");
assert(!body.includes("{{"), "no unrendered placeholders");

// Schema rejects extra + missing fields
let rejected = false;
try {
  validateArguments(hcv.inputSchema as object, {
    resource_name: "x",
    bogus: "y",
  } as any);
} catch (e) {
  rejected = e instanceof TfInputValidationError;
}
assert(rejected, "invalid args rejected (missing required + additionalProperties)");

// Optional {{#if}} block: s3 template without project_tag drops tags
const s3 = templates.find((t) => t.slug === "s3-static-site")!;
const s3body = renderTemplate(s3.versions[0].templateBody, {
  module_name: "site",
  bucket_name: "infralift-demo-site",
});
assert(!s3body.includes("tags"), "optional block dropped when input absent");
const s3tagged = renderTemplate(s3.versions[0].templateBody, {
  module_name: "site",
  bucket_name: "infralift-demo-site",
  project_tag: "demo",
});
assert(s3tagged.includes(`Project   = "demo"`), "optional block kept when input present");

// provider.tf + file naming
const prov = renderProviderFile({
  name: "aws",
  source: "hashicorp/aws",
  version: "~> 5.0",
  region: "us-west-2",
});
assert(prov.includes(`region = "us-west-2"`), "provider region pinned");
assert(
  renderedFileName("demo", "abc123") === "demo-job-abc123.tf",
  "rendered file naming convention"
);

// Pipeline: create org + project + job; expect errored at commit stage
// (no github connection) with render stage having produced a rendering.
const org = await prisma.org.create({ data: { name: "smoke-org" } });
const project = await prisma.tfProject.create({
  data: {
    orgId: org.id,
    name: "smoke",
    templateVersionId: hcv.id,
    destRepo: "jschell12/does-not-exist",
    providerConfig: {
      name: "aws",
      source: "hashicorp/aws",
      version: "~> 5.0",
      region: "us-west-2",
    },
  },
});
const job = await prisma.tfJob.create({
  data: { projectId: project.id, argumentsJson: args },
});
await runJob(job.id);
const done = await prisma.tfJob.findUniqueOrThrow({
  where: { id: job.id },
  include: { rendering: true },
});
assert(done.stage === "commit" && done.status === "errored", `job halts at commit without github token (${done.stage}/${done.status})`);
assert(done.rendering !== null, "rendering persisted before commit stage");
assert(
  done.rendering!.fileName === `smoke-job-${job.id}.tf`,
  "rendering file name matches convention"
);
assert(done.statusMessage.includes("github"), "status message explains missing connection");

// Bad-args job errors at render stage
const badJob = await prisma.tfJob.create({
  data: { projectId: project.id, argumentsJson: { resource_name: "x" } },
});
await runJob(badJob.id);
const badDone = await prisma.tfJob.findUniqueOrThrow({ where: { id: badJob.id } });
assert(
  badDone.stage === "render" && badDone.status === "errored",
  `bad args error at render stage (${badDone.stage}/${badDone.status})`
);

console.log("\nALL TF SMOKE TESTS PASSED");
await prisma.$disconnect();
