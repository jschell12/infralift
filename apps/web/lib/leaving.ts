// Data for the /leaving/<provider> landing pages.
//
// Every number here comes from the demo assessment pipeline: the bills are
// the seeded Northwind fixtures (apps/api/src/lib/demo-fixture.ts) and the
// exits are sizeTarget() output (apps/api/src/lib/sizing.ts), verified by
// unit tests in the api package. When a fixture or price table changes,
// update this file to match — the tests over there pin the source numbers.

export interface BillRow {
  label: string;
  perMonth: string; // pre-formatted, e.g. "$1,350"
}

export interface ExitLineItem {
  label: string;
  perMonth: string; // "$0" rows are the argument
  note?: string;
}

export interface LeavingPage {
  slug: string;
  provider: string;
  metaTitle: string;
  metaDescription: string;
  headline: string;
  intro: string;
  billTotal: string;
  billNote: string;
  bill: BillRow[];
  exitName: string;
  exitTotal: string;
  exitSavings: string;
  exit: ExitLineItem[];
  exitNote: string;
}

export const LEAVING_PAGES: LeavingPage[] = [
  {
    slug: "vercel",
    provider: "Vercel",
    metaTitle: "Leaving Vercel | infralift",
    metaDescription:
      "What a scaled Vercel account actually costs, and what the same workload runs on Cloudflare Workers. Free assessment, fixed-fee migration, no downtime.",
    headline: "The Vercel bill grows faster than the product does",
    intro:
      "Vercel is a great way to launch. At scale, the pricing model works against you: every seat is $20/mo before any traffic, and bandwidth past the included 1TB bills at $0.15/GB. Here is a typical 11-project account at 10TB/mo.",
    billTotal: "$2,760/mo",
    billNote: "Modeled from account shape and published pricing.",
    bill: [
      { label: "Bandwidth overage (9TB beyond the included 1TB, $0.15/GB)", perMonth: "$1,350" },
      { label: "Edge config reads + blob storage", perMonth: "$460" },
      { label: "Pro seats ×20", perMonth: "$400" },
      { label: "Function invocations (~50M/mo, $0.60/M)", perMonth: "$30" },
      { label: "Function duration (~1,500 GB-Hrs, $0.18/GB-Hr)", perMonth: "$270" },
      { label: "Image optimization", perMonth: "$250" },
    ],
    exitName: "Cloudflare Workers",
    exitTotal: "$34/mo",
    exitSavings: "$2,726/mo",
    exit: [
      { label: "Workers Paid plan", perMonth: "$5", note: "10M requests and 30M CPU-ms included" },
      { label: "Requests beyond included (~40M/mo)", perMonth: "$12" },
      { label: "CPU time beyond included", perMonth: "$9", note: "billed on active CPU, not waiting" },
      { label: "R2 storage (~500GB)", perMonth: "$8" },
      { label: "Egress (10TB)", perMonth: "$0", note: "Cloudflare does not bill bandwidth" },
      { label: "Team seats", perMonth: "$0", note: "no per-seat pricing. Everyone deploys." },
    ],
    exitNote:
      "The two $0 lines are the story. The largest item on the Vercel bill does not exist on the other side.",
  },
  {
    slug: "heroku",
    provider: "Heroku",
    metaTitle: "Leaving Heroku | infralift",
    metaDescription:
      "What a production Heroku app actually costs, and what the same workload runs on dedicated Hetzner instances with managed Postgres. Free assessment, fixed-fee migration.",
    headline: "Heroku is in maintenance mode. Your bill is not.",
    intro:
      "Performance dynos are $500/mo each and premium Postgres starts at $750/mo, for a platform Salesforce moved to sustaining engineering. Here is a typical production app: four web dynos, workers, HA Postgres and Redis.",
    billTotal: "$3,229/mo",
    billNote: "Priced from published dyno and add-on rates.",
    bill: [
      { label: "4× Performance-L web dynos", perMonth: "$2,000" },
      { label: "Postgres premium-0 (64GB, HA)", perMonth: "$750" },
      { label: "4× Standard-2X worker dynos", perMonth: "$200" },
      { label: "Redis premium-3 (5GB, HA)", perMonth: "$200" },
      { label: "Papertrail, CloudAMQP, staging dyno", perMonth: "$79" },
    ],
    exitName: "Hetzner + Neon + Upstash",
    exitTotal: "$422/mo",
    exitSavings: "$2,807/mo",
    exit: [
      { label: "1× CCX43 (16 vCPU / 64GB, dedicated)", perMonth: "$107" },
      { label: "2× CCX13 (2 vCPU / 8GB, dedicated)", perMonth: "$28" },
      { label: "Load balancer", perMonth: "$7" },
      { label: "Neon Postgres (2 CU always-on + storage)", perMonth: "$180", note: "replaces premium-0; pg_dump/pg_restore migration" },
      { label: "Upstash Redis (5GB fixed)", perMonth: "$100" },
      { label: "Egress", perMonth: "$0", note: "20TB+ included per instance" },
    ],
    exitNote:
      "Same RAM, dedicated vCPUs instead of shared dyno slices, and the databases stay managed. You just stop paying Heroku's markup on all of it.",
  },
  {
    slug: "render",
    provider: "Render",
    metaTitle: "Leaving Render | infralift",
    metaDescription:
      "What a five-service Render account actually costs once every service needs pro-tier RAM, and what the same workload runs on Hetzner. Free assessment, fixed-fee migration.",
    headline: "Per-service pricing compounds. Your architecture pays for it.",
    intro:
      "Render prices each service by instance plan. Split your app into five services and every one of them bills separately, plus managed databases, seats, and bandwidth. Here is a typical production account.",
    billTotal: "$1,189/mo",
    billNote: "Priced from published plan rates.",
    bill: [
      { label: "3× web services on Pro Plus (8GB)", perMonth: "$525" },
      { label: "Managed Postgres pro (4GB, 256GB disk)", perMonth: "$190" },
      { label: "2× background workers on Pro (4GB)", perMonth: "$170" },
      { label: "Organization seats ×8", perMonth: "$152" },
      { label: "Bandwidth beyond included 500GB", perMonth: "$120" },
      { label: "Managed Redis pro (5GB)", perMonth: "$32" },
    ],
    exitName: "Hetzner + Neon + Upstash",
    exitTotal: "$369/mo",
    exitSavings: "$820/mo",
    exit: [
      { label: "1× CCX33 (8 vCPU / 32GB, dedicated)", perMonth: "$54" },
      { label: "2× CCX13 (2 vCPU / 8GB, dedicated)", perMonth: "$28" },
      { label: "Load balancer", perMonth: "$7" },
      { label: "Neon Postgres (2 CU always-on + storage)", perMonth: "$180" },
      { label: "Upstash Redis (5GB fixed)", perMonth: "$100" },
      { label: "Egress + seats", perMonth: "$0", note: "no bandwidth billing, no per-seat pricing" },
    ],
    exitNote:
      "All five services run as containers on the same dedicated hardware. The per-service tax goes away; the databases stay managed.",
  },
  {
    slug: "railway",
    provider: "Railway",
    metaTitle: "Leaving Railway | infralift",
    metaDescription:
      "What a Railway account actually costs when compute, egress, and seats all bill by usage, and what the same workload runs on Hetzner. Free assessment, fixed-fee migration.",
    headline: "Usage-based billing means the bill decides itself",
    intro:
      "Railway meters compute by the vCPU-hour and GB-hour, bills egress by the GB, and charges $20/seat on Pro. None of those numbers are ones you approve in advance. Here is a six-service account under real traffic.",
    billTotal: "$980/mo",
    billNote: "Modeled from usage meters and published rates.",
    bill: [
      { label: "Service compute (6 always-on services)", perMonth: "$520" },
      { label: "Pro seats ×8", perMonth: "$160" },
      { label: "Egress (~1.5TB)", perMonth: "$150" },
      { label: "Plugin compute + storage (Postgres, Redis)", perMonth: "$150" },
    ],
    exitName: "Hetzner + Neon + Upstash",
    exitTotal: "$111/mo",
    exitSavings: "$869/mo",
    exit: [
      { label: "1× CCX13 (2 vCPU / 8GB, dedicated)", perMonth: "$14" },
      { label: "Load balancer", perMonth: "$7" },
      { label: "Neon Postgres (1 CU + storage)", perMonth: "$80" },
      { label: "Upstash Redis (250MB fixed)", perMonth: "$10" },
      { label: "Egress (~1.5TB)", perMonth: "$0", note: "20TB+ included" },
    ],
    exitNote:
      "A fixed number you can put in a budget. The bill stops moving with traffic and starts moving with decisions you make.",
  },
  {
    slug: "digitalocean",
    provider: "DigitalOcean",
    metaTitle: "Leaving DigitalOcean | infralift",
    metaDescription:
      "What droplets, DOKS, and managed databases actually cost on DigitalOcean, and what the same workload runs on Hetzner dedicated instances. Free assessment, fixed-fee migration.",
    headline: "You already run servers. You can run them at half the price.",
    intro:
      "DigitalOcean charges roughly double Hetzner's rate for comparable compute, and a Kubernetes cluster adds an operations tax most teams this size never needed. Here is a typical account: seven droplets, DOKS, HA Postgres and Redis.",
    billTotal: "$1,066/mo",
    billNote: "Priced from published droplet and database rates.",
    bill: [
      { label: "4× gd-2vcpu-8gb droplets", perMonth: "$288" },
      { label: "Managed Postgres (3-node HA)", perMonth: "$240" },
      { label: "Load balancers, backups, bandwidth overage", perMonth: "$204" },
      { label: "Managed Redis (2-node)", perMonth: "$180" },
      { label: "3× DOKS node-pool droplets", perMonth: "$144" },
      { label: "Spaces ×2", perMonth: "$10" },
    ],
    exitName: "Hetzner + Neon + Upstash",
    exitTotal: "$422/mo",
    exitSavings: "$644/mo",
    exit: [
      { label: "1× CCX43 (16 vCPU / 64GB, dedicated)", perMonth: "$107" },
      { label: "2× CCX13 (2 vCPU / 8GB, dedicated)", perMonth: "$28" },
      { label: "Load balancer", perMonth: "$7" },
      { label: "Neon Postgres (2 CU always-on + storage)", perMonth: "$180" },
      { label: "Upstash Redis (5GB fixed)", perMonth: "$100" },
      { label: "Egress (~2.2TB)", perMonth: "$0", note: "20TB+ included per instance" },
    ],
    exitNote:
      "Same amount of RAM on dedicated vCPUs, Docker Compose instead of Kubernetes, and the databases move to providers that price them honestly.",
  },
  {
    slug: "firebase",
    provider: "Firebase",
    metaTitle: "Leaving Firebase | infralift",
    metaDescription:
      "What per-operation Firebase billing actually costs at scale, and what the same workload runs on Cloudflare Workers. Free assessment, fixed-fee migration with the Firestore redesign scoped up front.",
    headline: "Every read is a line item. Growth is the bill.",
    intro:
      "Firebase bills per read, per write, per invocation, per GB, per monthly active user. Each meter scales with your growth, which is how the $70,000-in-a-day stories happen. Here is a production project at moderate scale.",
    billTotal: "$2,570/mo",
    billNote: "Modeled from operation counts and published rates.",
    bill: [
      { label: "Firestore reads/writes/deletes (~1.4B reads)", perMonth: "$900" },
      { label: "Network egress (~6TB)", perMonth: "$700" },
      { label: "Cloud Functions invocations (~120M)", perMonth: "$400" },
      { label: "Hosting bandwidth beyond free tier", perMonth: "$300" },
      { label: "Auth MAU beyond free tier", perMonth: "$270" },
    ],
    exitName: "Cloudflare Workers",
    exitTotal: "$61/mo",
    exitSavings: "$2,509/mo",
    exit: [
      { label: "Workers Paid plan", perMonth: "$5" },
      { label: "Requests beyond included (~110M/mo)", perMonth: "$33" },
      { label: "CPU time beyond included", perMonth: "$23" },
      { label: "Egress (~7.5TB)", perMonth: "$0", note: "Cloudflare does not bill bandwidth" },
      { label: "Auth + seats", perMonth: "$0", note: "no MAU billing, no per-seat pricing" },
    ],
    exitNote:
      "Honest caveat: Firestore's document model shapes the whole app, so this migration includes a relational redesign. infralift scopes that phase explicitly before quoting, and the quote is still fixed.",
  },
];

export function getLeavingPage(slug: string): LeavingPage | undefined {
  return LEAVING_PAGES.find((p) => p.slug === slug);
}
