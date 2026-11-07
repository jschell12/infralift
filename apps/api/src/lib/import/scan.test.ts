import { describe, expect, it } from "vitest";
import { isScanFile, joinPath, scanRepo } from "./scan.js";

const S3_ROOT = `
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  backend "s3" {
    bucket     = "acme-state"
    key        = "prod/terraform.tfstate"
    region     = "us-east-1"
    access_key = "AKIAEXAMPLE"
  }
}
variable "env" {}
variable "region" { default = "us-east-1" }
variable "db_password" {}
module "net" { source = "../../modules/net" }
resource "aws_instance" "web" { instance_type = "t3.micro" }
resource "aws_instance" "worker" { instance_type = "t3.micro" }
resource "random_id" "suffix" { byte_length = 4 }
data "aws_ami" "ubuntu" {}
`;

const MODULE = `
variable "cidr" {}
resource "aws_vpc" "this" { cidr_block = var.cidr }
`;

describe("scanRepo", () => {
  it("finds root modules, skips called modules, reads the backend", () => {
    const { roots, errors } = scanRepo([
      { path: "envs/prod/main.tf", content: S3_ROOT },
      { path: "envs/prod/terraform.tfvars", content: 'env = "prod"\n' },
      { path: "modules/net/main.tf", content: MODULE },
      { path: "README.md", content: "# not terraform" },
    ]);
    expect(errors).toEqual([]);
    expect(roots.map((r) => r.path)).toEqual(["envs/prod"]);
    const prod = roots[0];
    expect(prod.backend).toMatchObject({
      kind: "s3",
      type: "s3",
      partial: false,
      settings: { bucket: "acme-state", key: "prod/terraform.tfstate", region: "us-east-1" },
    });
    // The inline credential is reported, never echoed.
    expect(JSON.stringify(prod.backend)).not.toContain("AKIAEXAMPLE");
    expect(prod.notes.join(" ")).toMatch(/sets access_key in the code/);
    // The called module's aws_vpc is in this root's state too.
    expect(prod.resources).toBe(4);
    expect(prod.dataSources).toBe(1);
    expect(prod.moduleCalls).toBe(1);
    expect(prod.resourceTypes).toEqual({ aws_instance: 2, aws_vpc: 1, random_id: 1 });
    expect(prod.providers.map((p) => p.name)).toEqual(["aws", "random"]);
    // env comes from terraform.tfvars; region has a default.
    expect(prod.requiredVariables).toEqual(["db_password"]);
    expect(prod.credentials).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
    expect(prod.readiness).toBe("ready");
    expect(prod.tool).toBe("terraform");
  });

  it("tells R2 from S3 by its endpoint", () => {
    const { roots } = scanRepo([
      {
        path: "main.tf",
        content: `terraform {
  backend "s3" {
    bucket = "state"
    key    = "app.tfstate"
    region = "auto"
    endpoints = { s3 = "https://abc123.r2.cloudflarestorage.com" }
    skip_credentials_validation = true
  }
}
resource "hcloud_server" "app" {}
resource "cloudflare_record" "www" {}
`,
      },
    ]);
    expect(roots[0].path).toBe("");
    expect(roots[0].backend.kind).toBe("r2");
    expect(roots[0].credentials).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "CLOUDFLARE_API_TOKEN",
      "HCLOUD_TOKEN",
    ]);
  });

  it("routes Terraform Cloud to adoption and blocks local state", () => {
    const { roots } = scanRepo([
      { path: "tfc/main.tf", content: 'terraform {\n  cloud {\n    organization = "acme"\n  }\n}\nresource "aws_s3_bucket" "b" {}\n' },
      { path: "laptop/main.tf", content: 'resource "aws_s3_bucket" "b" {}\n' },
    ]);
    const byPath = Object.fromEntries(roots.map((r) => [r.path, r]));
    expect(byPath.tfc.backend.kind).toBe("tfc");
    expect(byPath.tfc.readiness).toBe("adopt-tfc");
    expect(byPath.laptop.backend.kind).toBe("local");
    expect(byPath.laptop.readiness).toBe("blocked");
  });

  it("uses a lone backend config file for a partial backend, blocks without one", () => {
    const partial = 'terraform {\n  backend "gcs" {}\n}\nresource "google_storage_bucket" "b" {}\n';
    const withFile = scanRepo([
      { path: "infra/main.tf", content: partial },
      { path: "infra/prod.tfbackend", content: 'bucket = "acme"\n' },
    ]).roots[0];
    expect(withFile.backend).toMatchObject({ kind: "gcs", partial: true, configFiles: ["infra/prod.tfbackend"] });
    expect(withFile.readiness).toBe("ready");
    expect(withFile.credentials).toEqual(["GOOGLE_CREDENTIALS"]);
    const without = scanRepo([{ path: "infra/main.tf", content: partial }]).roots[0];
    expect(without.readiness).toBe("blocked");
  });

  it("detects OpenTofu from the lock file", () => {
    const { roots } = scanRepo([
      { path: "main.tf", content: 'terraform {\n  backend "s3" {\n    bucket = "b"\n    key = "k"\n  }\n}\nresource "aws_s3_bucket" "b" {}\n' },
      { path: ".terraform.lock.hcl", content: 'provider "registry.opentofu.org/hashicorp/aws" {\n  version = "5.0.0"\n}\n' },
    ]);
    expect(roots[0].tool).toBe("tofu");
  });

  it("skips a backend with nothing under it", () => {
    const { roots } = scanRepo([
      { path: "retired/main.tf", content: 'terraform {\n  cloud {\n    organization = "acme"\n  }\n}\nprovider "hcloud" {}\n' },
    ]);
    expect(roots).toEqual([]);
  });

  it("does not loop on modules that call each other", () => {
    const { roots } = scanRepo([
      { path: "main.tf", content: 'module "a" { source = "./a" }\n' },
      { path: "a/main.tf", content: 'module "b" { source = "../b" }\nresource "aws_s3_bucket" "x" {}\n' },
      { path: "b/main.tf", content: 'module "a" { source = "../a" }\nresource "aws_s3_bucket" "y" {}\n' },
    ]);
    expect(roots.map((r) => [r.path, r.resources])).toEqual([["", 2]]);
  });

  it("reports a file that will not parse and scans the rest", () => {
    const { roots, errors } = scanRepo([
      { path: "a/main.tf", content: 'resource "x" "y" {\n' },
      { path: "a/ok.tf", content: 'resource "aws_s3_bucket" "b" {}\n' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("a/main.tf");
    expect(roots[0].resources).toBe(1);
  });

  it("names unknown providers instead of guessing their credentials", () => {
    const { roots } = scanRepo([
      { path: "main.tf", content: 'terraform {\n  backend "s3" {\n    bucket = "b"\n    key = "k"\n  }\n}\nresource "newrelic_alert_policy" "m" {}\n' },
    ]);
    expect(roots[0].notes.join(" ")).toMatch(/Provider newrelic/);
  });
});

describe("scan helpers", () => {
  it("reads only Terraform files outside .terraform", () => {
    expect(isScanFile("envs/prod/main.tf")).toBe(true);
    expect(isScanFile("envs/prod/.terraform/modules/x/main.tf")).toBe(false);
    expect(isScanFile("backend-prod.hcl")).toBe(true);
    expect(isScanFile("app/index.ts")).toBe(false);
  });

  it("joins module paths and refuses to climb out", () => {
    expect(joinPath("envs/prod", "../../modules/net")).toBe("modules/net");
    expect(joinPath("", "./modules/x")).toBe("modules/x");
    expect(joinPath("a", "../../x")).toBeNull();
  });
});
