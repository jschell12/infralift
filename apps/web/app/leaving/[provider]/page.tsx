import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LEAVING_PAGES, getLeavingPage } from "../../../lib/leaving";

import { DASHBOARD_URL, LEAD_FORM_ENABLED } from "../../../lib/links";
import { AssessmentForm } from "../../assessment-form";
import { SiteFooter, SiteHeader } from "../../site-chrome";

const CONTAINER = "max-w-[880px] mx-auto px-4 sm:px-6";
const CARD = "bg-surface border border-border rounded-xl p-6";
const BTN =
  "inline-block px-7 py-3 rounded-lg text-base font-semibold cursor-pointer border border-transparent bg-accent text-on-accent hover:brightness-95";

export const dynamicParams = false;

export function generateStaticParams() {
  return LEAVING_PAGES.map((p) => ({ provider: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ provider: string }>;
}): Promise<Metadata> {
  const { provider } = await params;
  const page = getLeavingPage(provider);
  if (!page) return { title: "infralift" };
  return { title: page.metaTitle, description: page.metaDescription };
}

export default async function LeavingPage({
  params,
}: {
  params: Promise<{ provider: string }>;
}) {
  const { provider } = await params;
  const page = getLeavingPage(provider);
  if (!page) notFound();

  return (
    <>
      <SiteHeader />

      <main className={CONTAINER}>
        <section className="pt-12 pb-10">
          <h1 className="text-3xl md:text-[38px] text-balance leading-tight font-bold tracking-[-0.02em] mb-4">
            {page.headline}
          </h1>
          <p className="text-muted text-[17px] max-w-[640px]">{page.intro}</p>
        </section>

        <section className="pb-10">
          <div className={`${CARD} border-danger/20`}>
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="text-lg font-semibold">
                A typical {page.provider} bill
              </h2>
              <span className="text-danger text-[26px] font-bold tracking-[-0.02em]">
                {page.billTotal}
              </span>
            </div>
            {page.bill.map((row) => (
              <div
                key={row.label}
                className="flex justify-between gap-4 border-t border-border py-2.5 text-[15px]"
              >
                <span className="text-muted">{row.label}</span>
                <span className="font-semibold shrink-0">{row.perMonth}</span>
              </div>
            ))}
            <p className="text-sm text-muted mt-3">{page.billNote}</p>
          </div>
        </section>

        <section className="pb-10">
          <div className={CARD}>
            <div className="flex items-baseline justify-between mb-1">
              <h2 className="text-lg font-semibold">
                The same workload on {page.exitName}
              </h2>
              <span className="text-text text-[26px] font-bold tracking-[-0.02em]">
                {page.exitTotal}
              </span>
            </div>
            <p className="text-sm text-muted mb-4">
              Sized from the workload above, not a marketing tier. Saves{" "}
              <strong className="text-text">{page.exitSavings}</strong>.
            </p>
            {page.exit.map((row) => (
              <div
                key={row.label}
                className="flex justify-between gap-4 border-t border-border py-2.5 text-[15px]"
              >
                <span className="text-muted">
                  {row.label}
                  {row.note ? (
                    <span className="text-sm"> — {row.note}</span>
                  ) : null}
                </span>
                <span
                  className={`font-semibold shrink-0 ${row.perMonth === "$0" ? "text-text" : ""}`}
                >
                  {row.perMonth}
                </span>
              </div>
            ))}
            <p className="text-sm text-muted mt-3">{page.exitNote}</p>
          </div>
        </section>

        <section className="pb-14">
          <div className={CARD}>
            <h2 className="text-lg font-semibold mb-2">
              The migration is the product
            </h2>
            <p className="text-muted text-[15px] max-w-[640px] mb-4">
              infralift builds the new environment in parallel with your live
              site, delivers everything as Terraform you own, then cuts over
              at the edge, which is reversible in seconds for as long as the
              old stack stays warm. Moving the database needs a short write
              pause, minutes long and sized from your data. The assessment
              is free and reads your account with a scoped token; the
              migration is a fixed fee quoted up front, so the price in the
              report is the price you pay.
            </p>
            <p className="text-muted text-sm max-w-[640px] mb-5">
              How we handle secrets, data sync, and the cutover itself:{" "}
              <a href="/docs/migration-process" className="text-text underline">
                the migration process
              </a>
              .
            </p>
            <a href={DASHBOARD_URL} className={BTN}>
              Run the free assessment
            </a>
            <p className="mt-3.5 text-sm text-muted">
              Sign in with Google or GitHub, then connect a read-only{" "}
              {page.provider} token.
            </p>

            {LEAD_FORM_ENABLED && (
              // The provider is already known on these pages, so prefill it
              // rather than making a visitor who just read about their own
              // bill tell us which one it was.
              <div className="mt-9 max-w-[620px] border-t border-border pt-8">
                <h3 className="mb-1.5 text-lg font-semibold">
                  Not ready to connect an account?
                </h3>
                <p className="mb-6 text-[15px] text-muted">
                  Tell us roughly what you are running and we will reply by
                  email.
                </p>
                <AssessmentForm provider={page.provider} />
              </div>
            )}
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
