import type { Metadata } from "next";
import { readDoc } from "../../lib/docs";

export const metadata: Metadata = {
  title: "Documentation | infralift",
  description:
    "How infralift works: granting read-only access, the assessment report, the fixed-fee migration process, and the security model.",
};

export default function DocsIndex() {
  const doc = readDoc();
  if (!doc) return <p>Documentation not found.</p>;
  return <article dangerouslySetInnerHTML={{ __html: doc.html }} />;
}
