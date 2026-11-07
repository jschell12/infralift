import { describe, expect, it } from "vitest";
import { HclParseError, parseHcl } from "./hcl.js";

describe("parseHcl", () => {
  it("reads blocks, labels and string attributes", () => {
    const body = parseHcl(`
terraform {
  required_version = ">= 1.6"
  backend "s3" {
    bucket = "acme-state" # trailing comment
    key    = "prod/terraform.tfstate"
    region = "us-east-1"
  }
}

resource "aws_instance" "web" {
  ami           = var.ami
  instance_type = "t3.micro"
  tags = {
    Name = "web-\${var.env}"
  }
}
`);
    const tf = body.blocks.find((b) => b.type === "terraform")!;
    const backend = tf.body.blocks[0];
    expect(backend.type).toBe("backend");
    expect(backend.labels).toEqual(["s3"]);
    expect(backend.body.attrs.bucket.str).toBe("acme-state");
    expect(backend.body.attrs.key.str).toBe("prod/terraform.tfstate");
    const web = body.blocks.find((b) => b.type === "resource")!;
    expect(web.labels).toEqual(["aws_instance", "web"]);
    expect(web.body.attrs.ami).toEqual({ raw: "var.ami" });
    expect(web.body.attrs.tags.raw).toContain("web-${var.env}");
    expect(web.body.attrs.tags.str).toBeUndefined();
  });

  it("keeps an interpolated string out of str", () => {
    const body = parseHcl('locals {\n  a = "x-${var.y}"\n  b = "plain"\n}\n');
    const l = body.blocks[0].body.attrs;
    expect(l.a.str).toBeUndefined();
    expect(l.b.str).toBe("plain");
  });

  it("skips heredocs, block comments and multi-line expressions", () => {
    const body = parseHcl(`
/* resource "fake" "x" { } */
resource "aws_iam_policy" "p" {
  policy = <<-EOT
    { "Statement": [ { "Effect": "Allow" } ] }
    resource "not" "real" {}
  EOT
  list = [
    "a",
    "b",
  ]
  cond = var.x ?
    "yes" :
    "no"
}
// resource "also" "fake" {}
module "net" {
  source = "./modules/net"
}
`);
    expect(body.blocks.map((b) => `${b.type}.${b.labels.join(".")}`)).toEqual([
      "resource.aws_iam_policy.p",
      "module.net",
    ]);
    const p = body.blocks[0].body.attrs;
    expect(Object.keys(p)).toEqual(["policy", "list", "cond"]);
    expect(body.blocks[1].body.attrs.source.str).toBe("./modules/net");
  });

  it("reads one-line blocks and nested object attributes", () => {
    const body = parseHcl(`
terraform {
  required_providers {
    hcloud = { source = "hetznercloud/hcloud", version = "~> 1.48" }
  }
}
provider "hcloud" { token = var.hcloud_token }
`);
    const rp = body.blocks[0].body.blocks[0];
    expect(rp.body.attrs.hcloud.raw).toContain('source = "hetznercloud/hcloud"');
    expect(body.blocks[1].body.attrs.token.raw).toBe("var.hcloud_token");
  });

  it("rejects an unclosed block", () => {
    expect(() => parseHcl('resource "a" "b" {\n  x = 1\n')).toThrow(HclParseError);
  });
});
