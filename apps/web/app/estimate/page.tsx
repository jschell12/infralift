import Link from "next/link";

import { DASHBOARD_URL } from "../../lib/links";
import { Calculator } from "./calculator";

const CONTAINER = "max-w-[1080px] mx-auto px-6";

export const metadata = {
  title: "What would your stack cost somewhere else? | infralift",
  description:
    "A cost estimate with the operations work priced in. No signup, no provider token, nothing stored.",
};

export default function EstimatePage() {
  return (
    <>
      <header className={CONTAINER}>
        <nav className="flex items-center justify-between py-5">
          <Link
            href="/"
            className="font-bold text-xl tracking-[-0.02em] text-text"
          >
            infra<span className="text-accent">lift</span>
          </Link>
          <div className="flex items-center gap-6">
            <Link href="/" className="text-muted text-[15px] hover:text-text">
              Home
            </Link>
            <Link
              href="/docs"
              className="text-muted text-[15px] hover:text-text"
            >
              Docs
            </Link>
            <a
              className="rounded-lg bg-accent px-5 py-2.5 text-[15px] font-semibold text-bg hover:bg-accent/90"
              href={DASHBOARD_URL}
            >
              Start assessment
            </a>
          </div>
        </nav>
      </header>

      <main className={CONTAINER}>
        <section className="pt-16 pb-10">
          <h1 className="max-w-[760px] text-[44px] font-bold leading-[1.15] tracking-[-0.03em]">
            What would your stack cost somewhere else?
          </h1>
          <p className="mt-5 max-w-[640px] text-lg text-muted">
            Answer eleven questions about what you run. You get a costed target
            architecture and, if you tell us your current bill, the difference.
            No signup, no provider token, and nothing you type is stored.
          </p>
          <p className="mt-4 max-w-[640px] text-[15px] text-muted">
            The operations work is priced in and subtracted. A managed
            platform&apos;s bill includes somebody patching the kernel; a VPS
            bill does not, and a savings number that ignores that is a number
            you should not trust.
          </p>
        </section>

        <section className="pb-16">
          <Calculator />
        </section>

        <section className="border-t border-border py-12">
          <h2 className="text-2xl font-bold tracking-[-0.02em]">
            What comes after the number
          </h2>
          <p className="mt-3 max-w-[640px] text-[15px] text-muted">
            This is arithmetic on what you typed. The free assessment reads your
            actual account, so it finds the things you would not have thought to
            enter. If the numbers still hold up after that, the migration plan
            is the paid deliverable: the target architecture, the Terraform, and
            a cutover runbook, in a repo you own.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a
              className="rounded-lg bg-accent px-6 py-3 text-[15px] font-semibold text-bg hover:bg-accent/90"
              href={DASHBOARD_URL}
            >
              Run the free assessment
            </a>
            <Link
              className="rounded-lg border border-border px-6 py-3 text-[15px] font-semibold text-text hover:border-accent"
              href="/docs/migration-process"
            >
              How the migration works
            </Link>
          </div>
        </section>
      </main>

      <footer
        className={`${CONTAINER} border-t border-border py-10 text-muted text-sm flex justify-between`}
      >
        <div>&copy; {new Date().getFullYear()} infralift</div>
        <div>Fixed-fee migrations, delivered as Terraform.</div>
      </footer>
    </>
  );
}
