import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { listDocSlugs, readDoc } from "../../../lib/docs";

export const dynamicParams = false;

export function generateStaticParams() {
  return listDocSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const doc = readDoc(slug);
  return { title: doc ? `${doc.title} | infralift` : "Documentation | infralift" };
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const doc = readDoc(slug);
  if (!doc) notFound();
  return <article dangerouslySetInnerHTML={{ __html: doc.html }} />;
}
