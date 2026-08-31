import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LEAVING_PAGES, getLeavingPage } from "../../../lib/leaving";

const DASHBOARD_URL =
  process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://dashboard.infralift.dev";

const CONTAINER = "max-w-[880px] mx-auto px-6";
const CARD = "bg-surface border border-border rounded-xl p-6";
const BTN =
  "inline-block px-7 py-3 rounded-lg text-base font-semibold cursor-pointer border border-transparent bg-accent text-bg hover:opacity-90";

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
      <header className={CONTAINER}>
        <nav className="flex items-center justify-between py-5">
          <a
            href="/"
            className="font-bold text-xl tracking-[-0.02em] text-text"
          >
            infra<span className="text-accent">lift</span>
          </a>
          <a href={DASHBOARD_URL} className={BTN}>
            Free assessment
          </a>
        </nav>
      </header>

      <main className={CONTAINER}>
        <section className="pt-12 pb-10">
          <p className="text-accent text-sm font-semibold uppercase tracking-[0.08em] mb-3">
            Leaving {page.provider}
          </p>
          <h1 className="text-[38px] leading-tight font-bold tracking-[-0.02em] mb-4">
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
          <div className={`${CARD} border-accent/20`}>
            <div className="flex items-baseline justify-between mb-1">
              <h2 className="text-lg font-semibold">
                The same workload on {page.exitName}
              </h2>
              <span className="text-accent text-[26px] font-bold tracking-[-0.02em]">
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
                  className={`font-semibold shrink-0 ${row.perMonth === "$0" ? "text-accent" : ""}`}
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
              at the edge with instant rollback. No downtime. The assessment
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
          </div>
        </section>
      </main>

      <footer
        className={`${CONTAINER} border-t border-border py-10 text-muted text-sm flex flex-wrap gap-x-6 gap-y-2`}
      >
        <span>infralift</span>
        {LEAVING_PAGES.map((p) => (
          <a
            key={p.slug}
            href={`/leaving/${p.slug}`}
            className={p.slug === page.slug ? "text-text" : ""}
          >
            Leaving {p.provider}
          </a>
        ))}
      </footer>
    </>
  );
}
