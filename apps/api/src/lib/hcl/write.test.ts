import { describe, expect, it } from "vitest";
import { attr, blank, block, comment, expr, file, quote } from "./write.js";
import { parseHcl } from "../import/hcl.js";

describe("HCL writer", () => {
  it("quotes strings so they stay literal", () => {
    expect(quote('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
    expect(quote("${var.x} and %{if}")).toBe('"$${var.x} and %%{if}"');
    expect(quote("line\nnext\ttab")).toBe('"line\\nnext\\ttab"');
  });

  it("prints blocks and aligns attributes the way terraform fmt does", () => {
    const out = file([
      comment("Managed by infralift."),
      block("terraform", [], [
        attr("required_version", ">= 1.10"),
        block("backend", ["s3"], [attr("bucket", "b"), attr("use_lockfile", true), attr("endpoints", { s3: "https://x" })]),
      ]),
      blank,
      block("provider", ["digitalocean"], []),
    ]);
    expect(out).toBe(
      [
        "# Managed by infralift.",
        "terraform {",
        '  required_version = ">= 1.10"',
        '  backend "s3" {',
        '    bucket       = "b"',
        "    use_lockfile = true",
        "    endpoints = {",
        '      s3 = "https://x"',
        "    }",
        "  }",
        "}",
        "",
        'provider "digitalocean" {}',
        "",
      ].join("\n")
    );
  });

  it("prints expressions as written and everything else as data", () => {
    const out = file([block("import", [], [attr("to", expr("aws_s3_bucket.b")), attr("id", "b")])]);
    expect(out).toContain("to = aws_s3_bucket.b");
    expect(out).toContain('id = "b"');
  });

  it("round-trips through the reader: a hostile value stays one string", () => {
    const hostile = 'x" }\nresource "evil" "e" { a = "${file("/etc/passwd")}';
    const parsed = parseHcl(file([block("locals", [], [attr("v", hostile)])]));
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0].body.blocks).toHaveLength(0);
    expect(Object.keys(parsed.blocks[0].body.attrs)).toEqual(["v"]);
  });

  it("reads back exactly the string it wrote", () => {
    for (const v of ["${var.x}", "50%{x}", "plain", 'q"uote', "a\\b"]) {
      expect(parseHcl(file([attr("v", v)])).attrs.v.str, v).toBe(v);
    }
  });

  it("refuses a name that is not an identifier", () => {
    expect(() => file([attr("bad name", 1)])).toThrow(/not an HCL identifier/);
    expect(() => file([block("x y", [], [])])).toThrow(/not an HCL identifier/);
  });
});
