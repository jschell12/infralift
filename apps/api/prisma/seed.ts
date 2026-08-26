import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Capability scores: 0 unsupported, 1 partial/workaround, 2 supported, 3 best-in-class.
// Keys: static_hosting, ssr, full_node_runtime, containers, background_workers,
// cron, websockets, managed_postgres, object_storage, edge_network, autoscaling,
// zero_devops, terraform_provider, gpu

interface SeedProvider {
  slug: string;
  name: string;
  category: string;
  websiteUrl: string;
  pricingModel: string;
  minMonthlyCents: number;
  typicalMonthlyCents: number;
  benefits: string;
  drawbacks: string;
  managedLevel: number;
  egressFreeGb: number;
  notes?: string;
  caps: Record<string, number>;
  plans: { name: string; monthlyCents: number; unit: string; includedNotes: string }[];
}

const providers: SeedProvider[] = [
  {
    slug: "vercel",
    name: "Vercel",
    category: "frontend_cloud",
    websiteUrl: "https://vercel.com",
    pricingModel: "hybrid",
    minMonthlyCents: 2000,
    typicalMonthlyCents: 6000,
    benefits:
      "Best-in-class Next.js DX; preview deploys per PR; zero-config edge network; instant rollbacks.",
    drawbacks:
      "Per-seat + usage pricing compounds fast; egress/function overages surprise at scale; ISR/edge features create lock-in.",
    managedLevel: 3,
    egressFreeGb: 100,
    caps: {
      static_hosting: 3, ssr: 3, full_node_runtime: 1, containers: 0,
      background_workers: 1, cron: 2, websockets: 1, managed_postgres: 1,
      object_storage: 1, edge_network: 3, autoscaling: 3, zero_devops: 3,
      terraform_provider: 2, gpu: 0,
    },
    plans: [
      { name: "Hobby", monthlyCents: 0, unit: "flat", includedNotes: "Non-commercial; 100GB bandwidth" },
      { name: "Pro", monthlyCents: 2000, unit: "seat", includedNotes: "$20/seat + usage overages" },
    ],
  },
  {
    slug: "netlify",
    name: "Netlify",
    category: "frontend_cloud",
    websiteUrl: "https://netlify.com",
    pricingModel: "hybrid",
    minMonthlyCents: 1900,
    typicalMonthlyCents: 4000,
    benefits:
      "Mature static/Jamstack platform; forms, identity, split testing built in; good framework coverage beyond Next.",
    drawbacks:
      "Serverless functions weaker than Vercel for SSR-heavy apps; usage pricing; less momentum than competitors.",
    managedLevel: 3,
    egressFreeGb: 100,
    caps: {
      static_hosting: 3, ssr: 2, full_node_runtime: 1, containers: 0,
      background_workers: 1, cron: 2, websockets: 0, managed_postgres: 0,
      object_storage: 1, edge_network: 2, autoscaling: 3, zero_devops: 3,
      terraform_provider: 1, gpu: 0,
    },
    plans: [
      { name: "Free", monthlyCents: 0, unit: "flat", includedNotes: "100GB bandwidth, 300 build min" },
      { name: "Pro", monthlyCents: 1900, unit: "seat", includedNotes: "$19/seat + usage" },
    ],
  },
  {
    slug: "cloudflare",
    name: "Cloudflare (Workers + Pages)",
    category: "edge",
    websiteUrl: "https://workers.cloudflare.com",
    pricingModel: "hybrid",
    minMonthlyCents: 500,
    typicalMonthlyCents: 1500,
    benefits:
      "Cheapest serious platform; global edge by default; R2 has zero egress fees; generous free tier; D1/KV/Queues/Durable Objects included.",
    drawbacks:
      "Workers runtime is not full Node (compat layer covers most, not all); CPU-time limits; local debugging story weaker; Postgres needs external provider or Hyperdrive.",
    managedLevel: 3,
    egressFreeGb: -1,
    notes: "infralift's primary migration target.",
    caps: {
      static_hosting: 3, ssr: 2, full_node_runtime: 1, containers: 1,
      background_workers: 2, cron: 3, websockets: 2, managed_postgres: 1,
      object_storage: 3, edge_network: 3, autoscaling: 3, zero_devops: 3,
      terraform_provider: 3, gpu: 0,
    },
    plans: [
      { name: "Workers Free", monthlyCents: 0, unit: "flat", includedNotes: "100k req/day" },
      { name: "Workers Paid", monthlyCents: 500, unit: "flat", includedNotes: "$5/mo + usage; 10M req included" },
    ],
  },
  {
    slug: "heroku",
    name: "Heroku",
    category: "paas",
    websiteUrl: "https://heroku.com",
    pricingModel: "fixed",
    minMonthlyCents: 500,
    typicalMonthlyCents: 7500,
    benefits:
      "The original git-push PaaS; huge add-on marketplace; battle-tested Postgres; dead-simple mental model.",
    drawbacks:
      "Expensive per dyno at production sizes; platform innovation stalled under Salesforce; no free tier since 2022; single-region dynos.",
    managedLevel: 3,
    egressFreeGb: 0,
    caps: {
      static_hosting: 1, ssr: 2, full_node_runtime: 3, containers: 2,
      background_workers: 3, cron: 2, websockets: 3, managed_postgres: 3,
      object_storage: 0, edge_network: 0, autoscaling: 2, zero_devops: 3,
      terraform_provider: 2, gpu: 0,
    },
    plans: [
      { name: "Eco", monthlyCents: 500, unit: "flat", includedNotes: "1000 dyno hours, sleeps" },
      { name: "Basic", monthlyCents: 700, unit: "dyno", includedNotes: "Always-on small dyno" },
      { name: "Standard-1X", monthlyCents: 2500, unit: "dyno", includedNotes: "Production dyno, metrics" },
    ],
  },
  {
    slug: "render",
    name: "Render",
    category: "paas",
    websiteUrl: "https://render.com",
    pricingModel: "fixed",
    minMonthlyCents: 700,
    typicalMonthlyCents: 3500,
    benefits:
      "Modern Heroku successor; predictable flat pricing; native cron, workers, managed Postgres/Redis; preview environments.",
    drawbacks:
      "Free tier spins down (cold starts); fewer regions than hyperscalers; occasional platform-wide incidents; egress billed.",
    managedLevel: 3,
    egressFreeGb: 100,
    caps: {
      static_hosting: 3, ssr: 2, full_node_runtime: 3, containers: 3,
      background_workers: 3, cron: 3, websockets: 3, managed_postgres: 3,
      object_storage: 1, edge_network: 1, autoscaling: 2, zero_devops: 3,
      terraform_provider: 1, gpu: 0,
    },
    plans: [
      { name: "Free", monthlyCents: 0, unit: "app", includedNotes: "Spins down after idle" },
      { name: "Starter", monthlyCents: 700, unit: "app", includedNotes: "512MB always-on service" },
    ],
  },
  {
    slug: "railway",
    name: "Railway",
    category: "paas",
    websiteUrl: "https://railway.com",
    pricingModel: "usage",
    minMonthlyCents: 500,
    typicalMonthlyCents: 2000,
    benefits:
      "Excellent DX; deploy anything from a Dockerfile or Nixpacks; per-second usage billing; built-in Postgres/Redis/volumes.",
    drawbacks:
      "Usage billing is unpredictable for spiky workloads; smaller company risk; no free tier beyond trial credit.",
    managedLevel: 3,
    egressFreeGb: 0,
    caps: {
      static_hosting: 2, ssr: 2, full_node_runtime: 3, containers: 3,
      background_workers: 3, cron: 3, websockets: 3, managed_postgres: 3,
      object_storage: 1, edge_network: 0, autoscaling: 2, zero_devops: 3,
      terraform_provider: 0, gpu: 0,
    },
    plans: [
      { name: "Hobby", monthlyCents: 500, unit: "usage", includedNotes: "$5 min, includes $5 usage" },
      { name: "Pro", monthlyCents: 2000, unit: "usage", includedNotes: "$20/seat min + usage" },
    ],
  },
  {
    slug: "flyio",
    name: "Fly.io",
    category: "container",
    websiteUrl: "https://fly.io",
    pricingModel: "usage",
    minMonthlyCents: 200,
    typicalMonthlyCents: 2500,
    benefits:
      "Firecracker VMs close to users in 30+ regions; real TCP/UDP + websockets; scale-to-zero machines; great for global low-latency apps.",
    drawbacks:
      "You manage more than a PaaS (Postgres is 'unmanaged managed'); support and reliability complaints; sharp edges in networking.",
    managedLevel: 2,
    egressFreeGb: 100,
    caps: {
      static_hosting: 1, ssr: 2, full_node_runtime: 3, containers: 3,
      background_workers: 3, cron: 1, websockets: 3, managed_postgres: 1,
      object_storage: 1, edge_network: 2, autoscaling: 3, zero_devops: 1,
      terraform_provider: 1, gpu: 2,
    },
    plans: [
      { name: "Pay-as-you-go", monthlyCents: 200, unit: "vm", includedNotes: "shared-cpu-1x from ~$2/mo" },
    ],
  },
  {
    slug: "aws",
    name: "AWS",
    category: "hyperscaler",
    websiteUrl: "https://aws.amazon.com",
    pricingModel: "usage",
    minMonthlyCents: 0,
    typicalMonthlyCents: 15000,
    benefits:
      "Every service imaginable; deepest maturity, compliance, and regions; free tier for 12 months; industry-standard skills.",
    drawbacks:
      "Extreme complexity; cost sprawl (NAT gateways, egress, idle LBs); needs real DevOps investment; console-driven drift is endemic.",
    managedLevel: 1,
    egressFreeGb: 100,
    caps: {
      static_hosting: 2, ssr: 2, full_node_runtime: 3, containers: 3,
      background_workers: 3, cron: 3, websockets: 3, managed_postgres: 3,
      object_storage: 3, edge_network: 2, autoscaling: 3, zero_devops: 0,
      terraform_provider: 3, gpu: 3,
    },
    plans: [
      { name: "Pay-as-you-go", monthlyCents: 0, unit: "usage", includedNotes: "Per-service metering" },
    ],
  },
  {
    slug: "gcp",
    name: "Google Cloud (Cloud Run)",
    category: "hyperscaler",
    websiteUrl: "https://cloud.google.com/run",
    pricingModel: "usage",
    minMonthlyCents: 0,
    typicalMonthlyCents: 10000,
    benefits:
      "Cloud Run is the best serverless-container product; scale-to-zero; strong data/ML stack; cleaner console than AWS.",
    drawbacks:
      "Still hyperscaler complexity; billing requires vigilance; fewer third-party resources than AWS; Google product-sunset reputation.",
    managedLevel: 1,
    egressFreeGb: 0,
    caps: {
      static_hosting: 2, ssr: 2, full_node_runtime: 3, containers: 3,
      background_workers: 3, cron: 3, websockets: 2, managed_postgres: 3,
      object_storage: 3, edge_network: 2, autoscaling: 3, zero_devops: 1,
      terraform_provider: 3, gpu: 3,
    },
    plans: [
      { name: "Pay-as-you-go", monthlyCents: 0, unit: "usage", includedNotes: "Cloud Run free tier: 2M req/mo" },
    ],
  },
  {
    slug: "firebase",
    name: "Firebase",
    category: "baas",
    websiteUrl: "https://firebase.google.com",
    pricingModel: "usage",
    minMonthlyCents: 0,
    typicalMonthlyCents: 8000,
    benefits:
      "Fastest mobile/web backend bootstrap; Auth, FCM push, and realtime sync are best-in-class; generous Spark free tier; deep Google ecosystem integration.",
    drawbacks:
      "Firestore per-read/write pricing punishes chatty apps at scale; NoSQL data model and security rules create heavy lock-in; no SQL; egress via GCP rates; Google sunset risk perception.",
    managedLevel: 3,
    egressFreeGb: 10,
    notes: "Common infralift migration source — Firestore pricing and lock-in are the usual exit drivers.",
    caps: {
      static_hosting: 3, ssr: 1, full_node_runtime: 1, containers: 0,
      background_workers: 2, cron: 2, websockets: 3, managed_postgres: 0,
      object_storage: 3, edge_network: 2, autoscaling: 3, zero_devops: 3,
      terraform_provider: 2, gpu: 0,
    },
    plans: [
      { name: "Spark", monthlyCents: 0, unit: "flat", includedNotes: "Free: 50k Firestore reads/day, 10GB hosting" },
      { name: "Blaze", monthlyCents: 0, unit: "usage", includedNotes: "Pay-as-you-go beyond free quotas" },
    ],
  },
  {
    slug: "azure",
    name: "Microsoft Azure",
    category: "hyperscaler",
    websiteUrl: "https://azure.microsoft.com",
    pricingModel: "usage",
    minMonthlyCents: 0,
    typicalMonthlyCents: 15000,
    benefits:
      "Best for Microsoft/AD-centric orgs; enterprise agreements and credits common; App Service is a capable PaaS.",
    drawbacks:
      "Weakest DX of the big three for startups; portal complexity; documentation inconsistency; overkill for small apps.",
    managedLevel: 1,
    egressFreeGb: 100,
    caps: {
      static_hosting: 2, ssr: 2, full_node_runtime: 3, containers: 3,
      background_workers: 3, cron: 3, websockets: 3, managed_postgres: 3,
      object_storage: 3, edge_network: 2, autoscaling: 3, zero_devops: 1,
      terraform_provider: 3, gpu: 3,
    },
    plans: [
      { name: "Pay-as-you-go", monthlyCents: 0, unit: "usage", includedNotes: "App Service Basic from ~$13/mo" },
    ],
  },
  {
    slug: "digitalocean",
    name: "DigitalOcean",
    category: "vps",
    websiteUrl: "https://digitalocean.com",
    pricingModel: "fixed",
    minMonthlyCents: 400,
    typicalMonthlyCents: 2400,
    benefits:
      "Simple, predictable VPS pricing; App Platform PaaS option; managed Postgres; good docs; middle ground between VPS and PaaS.",
    drawbacks:
      "Fewer managed services than hyperscalers; App Platform less polished than Render/Vercel; you still patch Droplets.",
    managedLevel: 2,
    egressFreeGb: 500,
    caps: {
      static_hosting: 2, ssr: 2, full_node_runtime: 3, containers: 3,
      background_workers: 2, cron: 2, websockets: 3, managed_postgres: 3,
      object_storage: 2, edge_network: 1, autoscaling: 1, zero_devops: 1,
      terraform_provider: 3, gpu: 2,
    },
    plans: [
      { name: "Droplet Basic", monthlyCents: 400, unit: "vm", includedNotes: "512MB/1vCPU" },
      { name: "App Platform Basic", monthlyCents: 500, unit: "app", includedNotes: "PaaS mode" },
    ],
  },
  {
    slug: "hetzner",
    name: "Hetzner",
    category: "vps",
    websiteUrl: "https://hetzner.com",
    pricingModel: "fixed",
    minMonthlyCents: 400,
    typicalMonthlyCents: 1200,
    benefits:
      "Unbeatable price/performance (2-3x the compute per dollar vs DO); generous 20TB egress; EU + US regions; solid API + Terraform provider.",
    drawbacks:
      "Zero managed app services — bring your own everything; support is minimal; account verification friction for new signups.",
    managedLevel: 0,
    egressFreeGb: 20000,
    notes: "infralift's default VPS target paired with Coolify or Docker Compose.",
    caps: {
      static_hosting: 1, ssr: 1, full_node_runtime: 3, containers: 3,
      background_workers: 2, cron: 2, websockets: 3, managed_postgres: 0,
      object_storage: 2, edge_network: 0, autoscaling: 1, zero_devops: 0,
      terraform_provider: 3, gpu: 2,
    },
    plans: [
      { name: "CX22", monthlyCents: 450, unit: "vm", includedNotes: "2vCPU/4GB/40GB, 20TB egress" },
      { name: "CX32", monthlyCents: 800, unit: "vm", includedNotes: "4vCPU/8GB/80GB" },
    ],
  },
  {
    slug: "linode",
    name: "Linode (Akamai)",
    category: "vps",
    websiteUrl: "https://linode.com",
    pricingModel: "fixed",
    minMonthlyCents: 500,
    typicalMonthlyCents: 2400,
    benefits:
      "Reliable straightforward VPS; Akamai edge integration potential; predictable pricing; good uptime record.",
    drawbacks:
      "Post-acquisition product direction unclear; fewer managed services; DX behind DigitalOcean.",
    managedLevel: 1,
    egressFreeGb: 1000,
    caps: {
      static_hosting: 1, ssr: 1, full_node_runtime: 3, containers: 3,
      background_workers: 2, cron: 2, websockets: 3, managed_postgres: 2,
      object_storage: 2, edge_network: 2, autoscaling: 1, zero_devops: 0,
      terraform_provider: 3, gpu: 2,
    },
    plans: [
      { name: "Nanode", monthlyCents: 500, unit: "vm", includedNotes: "1GB/1vCPU" },
    ],
  },
  {
    slug: "selfhosted-vps",
    name: "Self-hosted VPS (Coolify/Dokku)",
    category: "vps",
    websiteUrl: "https://coolify.io",
    pricingModel: "fixed",
    minMonthlyCents: 500,
    typicalMonthlyCents: 2000,
    benefits:
      "Total control and fixed cost; Coolify/Dokku give a PaaS-like deploy flow on your own box; no per-seat, no usage surprises; everything Terraformable.",
    drawbacks:
      "You are the ops team: patching, backups, monitoring, security hardening; single-server = single point of failure unless you build HA.",
    managedLevel: 0,
    egressFreeGb: 20000,
    caps: {
      static_hosting: 2, ssr: 2, full_node_runtime: 3, containers: 3,
      background_workers: 3, cron: 3, websockets: 3, managed_postgres: 1,
      object_storage: 1, edge_network: 0, autoscaling: 0, zero_devops: 0,
      terraform_provider: 2, gpu: 1,
    },
    plans: [
      { name: "BYO server", monthlyCents: 500, unit: "vm", includedNotes: "Coolify is free OSS; pay for the VPS" },
    ],
  },
  {
    slug: "github-pages",
    name: "GitHub Pages",
    category: "static",
    websiteUrl: "https://pages.github.com",
    pricingModel: "free_tier",
    minMonthlyCents: 0,
    typicalMonthlyCents: 0,
    benefits:
      "Free static hosting from a repo; custom domains + HTTPS; zero infrastructure; Actions-based builds.",
    drawbacks:
      "Static only — no SSR, functions, or backends; soft 100GB/mo bandwidth; 10-min build limit; public repos on free plans.",
    managedLevel: 3,
    egressFreeGb: 100,
    caps: {
      static_hosting: 3, ssr: 0, full_node_runtime: 0, containers: 0,
      background_workers: 0, cron: 0, websockets: 0, managed_postgres: 0,
      object_storage: 0, edge_network: 2, autoscaling: 2, zero_devops: 3,
      terraform_provider: 1, gpu: 0,
    },
    plans: [
      { name: "Free", monthlyCents: 0, unit: "flat", includedNotes: "Public repos; 100GB/mo soft cap" },
    ],
  },
];

// Discount programs — researched 2026-08 from HN/Reddit/LowEndTalk, FinOps
// advisories (Redress, CloudForecast, VendorBenchmark), and official program
// pages. confidence: corroborated (multiple independent sources), advisor
// (advisory-published curves only), anecdote (single report), unverified.
// Tier commits are whole USD/year; discounts are basis points off list.
interface SeedProgram {
  providerSlug: string;
  kind: string; // startup_credit | committed_spend | auction
  name: string;
  creditMaxCents?: number;
  creditDurationMonths?: number;
  creditMonthlyCapCents?: number;
  confidence: string;
  sourceNote?: string;
  sourceDate?: string;
  notes?: string;
  tiers?: { minAnnualCommitUsd: number; discountBps: number }[];
}

const programs: SeedProgram[] = [
  // --- AWS ---
  {
    providerSlug: "aws",
    kind: "startup_credit",
    name: "AWS Activate (portfolio)",
    creditMaxCents: 200_000_00,
    creditDurationMonths: 24,
    confidence: "corroborated",
    sourceNote: "aws.amazon.com/startups/credits; requires Activate Provider org ID; gen-AI tier up to $300k",
    sourceDate: "2026-08",
    notes: "12–24mo expiry, no extensions; credits exclude Marketplace, support fees, SP/RI upfronts; credited usage does not burn a PPA commit.",
  },
  {
    providerSlug: "aws",
    kind: "committed_spend",
    name: "Private Pricing Agreement (ex-EDP)",
    confidence: "corroborated",
    sourceNote: "Redress/CloudForecast 2026 benchmarks; HN 35113812 (14% on-demand); SEC-filed 9% (MiX Telematics)",
    sourceDate: "2026-08",
    notes: "Stacks on top of Savings Plans/RIs. Marketplace burn-down capped at 25% of commit since May 2025. Commit must not decrease YoY; Enterprise Support required.",
    tiers: [
      { minAnnualCommitUsd: 1_000_000, discountBps: 750 },
      { minAnnualCommitUsd: 10_000_000, discountBps: 1500 },
      { minAnnualCommitUsd: 50_000_000, discountBps: 2000 },
    ],
  },
  // --- GCP (also applies to Firebase — same billing account) ---
  {
    providerSlug: "gcp",
    kind: "startup_credit",
    name: "Google for Startups Cloud",
    creditMaxCents: 200_000_00,
    creditDurationMonths: 24,
    confidence: "corroborated",
    sourceNote: "cloud.google.com/startup; AI-first tier up to $350k",
    sourceDate: "2026-08",
    notes: "Equity-funded pre-seed–Series A; Google reserves the right to revoke extended credits.",
  },
  {
    providerSlug: "gcp",
    kind: "committed_spend",
    name: "Enterprise Agreement + spend CUDs",
    confidence: "advisor",
    sourceNote: "VendorBenchmark 2026-04 curve; no community anecdotes found",
    sourceDate: "2026-08",
    notes: "Most aggressive displacement discounts of the big three (30%+ with competitor quote). CUDs stack on the negotiated layer. Egress unprotected unless negotiated.",
    tiers: [
      { minAnnualCommitUsd: 500_000, discountBps: 700 },
      { minAnnualCommitUsd: 1_000_000, discountBps: 1400 },
      { minAnnualCommitUsd: 5_000_000, discountBps: 2200 },
      { minAnnualCommitUsd: 50_000_000, discountBps: 3500 },
    ],
  },
  {
    providerSlug: "firebase",
    kind: "startup_credit",
    name: "Google for Startups Cloud (covers Firebase Blaze)",
    creditMaxCents: 200_000_00,
    creditDurationMonths: 24,
    confidence: "corroborated",
    sourceNote: "Firebase Blaze bills through GCP, so GCP startup credits apply",
    sourceDate: "2026-08",
  },
  // --- Azure ---
  {
    providerSlug: "azure",
    kind: "startup_credit",
    name: "Microsoft for Startups (investor track)",
    creditMaxCents: 100_000_00,
    creditDurationMonths: 12,
    confidence: "corroborated",
    sourceNote: "Program restructured 2025-07-02: open $150k ladder gone; $5k self-serve; $100k+ needs VC/accelerator referral",
    sourceDate: "2026-08",
  },
  {
    providerSlug: "azure",
    kind: "committed_spend",
    name: "MACC / MCA-E",
    confidence: "advisor",
    sourceNote: "Redress 2025-12 + US Cloud curves; no community anecdotes found",
    sourceDate: "2026-08",
    notes: "Marketplace ISV purchases count 100% toward commit (vs AWS 25% cap). Shortfall back-billed at term end; ~half of customers oversize commits 15–30%.",
    tiers: [
      { minAnnualCommitUsd: 250_000, discountBps: 750 },
      { minAnnualCommitUsd: 1_000_000, discountBps: 1250 },
      { minAnnualCommitUsd: 3_000_000, discountBps: 1850 },
      { minAnnualCommitUsd: 25_000_000, discountBps: 3000 },
    ],
  },
  // --- Cloudflare ---
  {
    providerSlug: "cloudflare",
    kind: "startup_credit",
    name: "Cloudflare for Startups",
    creditMaxCents: 250_000_00,
    creditDurationMonths: 12,
    confidence: "corroborated",
    sourceNote: "Tiers $5k/$25k/$100k/$250k; $5k tier open to bootstrapped",
    sourceDate: "2026-08",
  },
  {
    providerSlug: "cloudflare",
    kind: "committed_spend",
    name: "Enterprise contract",
    confidence: "corroborated",
    sourceNote: "HN leaks: entry $3–5k/mo (HN 35965058); multi-year 10–20% off; renewal-hike pattern well documented (HN 40481808, 48608394)",
    sourceDate: "2026-08",
    notes: "Cheap year 1, aggressive renewal posture — demand renewal uplift caps in writing. Contract language allows termination if usage caps are exceeded without a re-price.",
    tiers: [{ minAnnualCommitUsd: 36_000, discountBps: 1500 }],
  },
  // --- Vercel ---
  {
    providerSlug: "vercel",
    kind: "startup_credit",
    name: "Vercel for Startups",
    creditMaxCents: 30_000_00,
    creditDurationMonths: 12,
    confidence: "corroborated",
    sourceNote: "vercel.com/startups/credits; Series A or earlier via approved partner; terms as of 2026-08-06",
    sourceDate: "2026-08",
    notes: "No rollover; only 50% of monthly allocation usable on AI Gateway.",
  },
  // --- DigitalOcean ---
  {
    providerSlug: "digitalocean",
    kind: "startup_credit",
    name: "DigitalOcean Startups",
    creditMaxCents: 100_000_00,
    creditDurationMonths: 12,
    creditMonthlyCapCents: 10_000_00,
    confidence: "corroborated",
    sourceNote: "digitalocean.com/startups, 2026-05 terms",
    sourceDate: "2026-08",
    notes: "~$10k/mo use-it-or-lose-it — cannot be banked; GPU products excluded. Raised ≤$10M.",
  },
  // --- Heroku ---
  {
    providerSlug: "heroku",
    kind: "startup_credit",
    name: "Heroku OSS credits",
    creditMaxCents: 6_000_00,
    creditDurationMonths: 12,
    creditMonthlyCapCents: 500_00,
    confidence: "corroborated",
    sourceNote: "heroku.com/open-source-credit-program: $25–500/mo; no general startup amounts published",
    sourceDate: "2026-08",
  },
  // --- Render ---
  {
    providerSlug: "render",
    kind: "startup_credit",
    name: "Render startup program",
    creditMaxCents: 50_000_00,
    creditDurationMonths: 12,
    confidence: "unverified",
    sourceNote: "Commonly cited ~$50k in 2026 credit-stacking guides; not confirmed on render.com",
    sourceDate: "2026-08",
  },
  // --- Hetzner ---
  {
    providerSlug: "hetzner",
    kind: "auction",
    name: "Serverbörse (server auction)",
    confidence: "corroborated",
    sourceNote: "LowEndTalk consensus: no negotiated discounts; auction is the discount channel (HN 49111648 2026-07, 46897416 2026-02)",
    sourceDate: "2026-08",
    notes: "Reverse auction on post-ROI hardware; ~30–50% below equivalent new-dedicated list. No commitment required.",
    tiers: [{ minAnnualCommitUsd: 0, discountBps: 4000 }],
  },
  // --- Linode / Akamai ---
  {
    providerSlug: "linode",
    kind: "committed_spend",
    name: "Akamai committed-use",
    confidence: "advisor",
    sourceNote: "VendorBenchmark 2026: 10–22% 1yr / 22–35% 3yr; sales worthwhile from ~$350/mo; no first-person confirmations",
    sourceDate: "2026-08",
    tiers: [
      { minAnnualCommitUsd: 4_200, discountBps: 1600 },
      { minAnnualCommitUsd: 1_000_000, discountBps: 3000 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Terraform generation starter templates. Body syntax: {{var}} interpolation,
// {{#if var}}...{{/if}} optional blocks (see src/lib/tf/render.ts).
// ---------------------------------------------------------------------------

interface SeedTfTemplate {
  slug: string;
  name: string;
  description: string;
  releaseTag: string;
  templateBody: string;
  inputSchema: object;
}

const tfTemplates: SeedTfTemplate[] = [
  {
    slug: "s3-static-site",
    name: "S3 static site bucket",
    description:
      "S3 bucket (registry module) for static-site hosting — landing zone for Vercel/Firebase Hosting migrations.",
    releaseTag: "v1",
    templateBody: `module "{{module_name}}" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "4.6.0"

  bucket        = "{{bucket_name}}"
  force_destroy = false
{{#if project_tag}}
  tags = {
    Project   = "{{project_tag}}"
    ManagedBy = "infralift"
  }
{{/if}}
}

output "{{module_name}}_bucket_regional_domain" {
  value = module.{{module_name}}.s3_bucket_bucket_regional_domain_name
}
`,
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        module_name: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
        bucket_name: { type: "string", minLength: 3, maxLength: 63 },
        project_tag: { type: "string" },
      },
      required: ["module_name", "bucket_name"],
      additionalProperties: false,
    },
  },
  {
    slug: "route53-healthcheck",
    name: "Route 53 health check",
    description:
      "HTTPS health check against an endpoint — first safety net when cutting traffic over during a migration.",
    releaseTag: "v1",
    templateBody: `resource "aws_route53_health_check" "{{resource_name}}" {
  fqdn              = "{{fqdn}}"
  type              = "HTTPS"
  port              = 443
  resource_path     = "{{resource_path}}"
  failure_threshold = 3
  request_interval  = 30

  tags = {
    Name      = "{{resource_name}}"
    ManagedBy = "infralift"
  }
}

output "{{resource_name}}_healthcheck_id" {
  value = aws_route53_health_check.{{resource_name}}.id
}
`,
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        resource_name: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
        fqdn: { type: "string", minLength: 1 },
        resource_path: { type: "string", pattern: "^/" },
      },
      required: ["resource_name", "fqdn", "resource_path"],
      additionalProperties: false,
    },
  },
  {
    slug: "apprunner-service",
    name: "App Runner container service",
    description:
      "AWS App Runner service from a public container image — the usual landing zone for Heroku dyno migrations.",
    releaseTag: "v1",
    templateBody: `resource "aws_apprunner_service" "{{service_name}}" {
  service_name = "{{service_name}}"

  source_configuration {
    image_repository {
      image_identifier      = "{{image}}"
      image_repository_type = "ECR_PUBLIC"
      image_configuration {
        port = "{{port}}"
      }
    }
    auto_deployments_enabled = false
  }

  instance_configuration {
    cpu    = "{{cpu}}"
    memory = "{{memory}}"
  }

  tags = {
    ManagedBy = "infralift"
  }
}

output "{{service_name}}_url" {
  value = aws_apprunner_service.{{service_name}}.service_url
}
`,
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        service_name: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
        image: { type: "string", minLength: 1 },
        port: { type: "integer", minimum: 1, maximum: 65535 },
        cpu: { type: "string", enum: ["256", "512", "1024", "2048", "4096"] },
        memory: {
          type: "string",
          enum: ["512", "1024", "2048", "3072", "4096", "8192"],
        },
      },
      required: ["service_name", "image", "port", "cpu", "memory"],
      additionalProperties: false,
    },
  },
];

async function main() {
  for (const p of providers) {
    const { caps, plans, ...data } = p;
    const provider = await prisma.hostingProvider.upsert({
      where: { slug: p.slug },
      create: data,
      update: data,
    });
    for (const [key, score] of Object.entries(caps)) {
      await prisma.providerCapability.upsert({
        where: { providerId_key: { providerId: provider.id, key } },
        create: { providerId: provider.id, key, score },
        update: { score },
      });
    }
    for (const plan of plans) {
      await prisma.providerPlan.upsert({
        where: { providerId_name: { providerId: provider.id, name: plan.name } },
        create: { providerId: provider.id, ...plan },
        update: plan,
      });
    }
  }

  for (const prog of programs) {
    const provider = await prisma.hostingProvider.findUnique({
      where: { slug: prog.providerSlug },
    });
    if (!provider) continue;
    const { providerSlug, tiers, ...data } = prog;
    const program = await prisma.discountProgram.upsert({
      where: { providerId_name: { providerId: provider.id, name: prog.name } },
      create: { providerId: provider.id, ...data },
      update: data,
    });
    for (const tier of tiers ?? []) {
      await prisma.discountTier.upsert({
        where: {
          programId_minAnnualCommitUsd: {
            programId: program.id,
            minAnnualCommitUsd: tier.minAnnualCommitUsd,
          },
        },
        create: { programId: program.id, ...tier },
        update: { discountBps: tier.discountBps },
      });
    }
  }
  for (const t of tfTemplates) {
    const { releaseTag, templateBody, inputSchema, ...meta } = t;
    const template = await prisma.tfTemplate.upsert({
      where: { slug: t.slug },
      create: meta,
      update: { name: meta.name, description: meta.description },
    });
    await prisma.tfTemplateVersion.upsert({
      where: {
        templateId_releaseTag: { templateId: template.id, releaseTag },
      },
      create: {
        templateId: template.id,
        releaseTag,
        templateBody,
        inputSchema,
      },
      update: { templateBody, inputSchema },
    });
  }

  // ---------------------------------------------------------------------------
  // Community sources — forums, subreddits, Discords where target audience
  // discusses cloud costs, migrations, and hosting decisions.
  // ---------------------------------------------------------------------------

  interface SeedCommunity {
    slug: string;
    name: string;
    platform: string;
    url: string;
    category: string;
    audience: string;
    relevance: string;
    memberCount?: number;
    notes?: string;
  }

  const communities: SeedCommunity[] = [
    // --- Reddit ---
    { slug: "reddit-selfhosted", name: "r/selfhosted", platform: "reddit", url: "https://reddit.com/r/selfhosted", category: "selfhosting", audience: "Developers and sysadmins who self-host services", relevance: "Top self-hosting community; daily discussions about migrating off cloud providers to VPS/homelab", memberCount: 400000 },
    { slug: "reddit-devops", name: "r/devops", platform: "reddit", url: "https://reddit.com/r/devops", category: "devops", audience: "DevOps engineers and SREs", relevance: "Infrastructure decisions, cloud cost complaints, IaC discussions", memberCount: 300000 },
    { slug: "reddit-webdev", name: "r/webdev", platform: "reddit", url: "https://reddit.com/r/webdev", category: "frontend", audience: "Web developers", relevance: "Hosting platform debates (Vercel vs Netlify vs self-host), deployment discussions", memberCount: 1000000 },
    { slug: "reddit-nextjs", name: "r/nextjs", platform: "reddit", url: "https://reddit.com/r/nextjs", category: "frontend", audience: "Next.js developers", relevance: "Vercel pricing complaints, self-hosting Next.js threads, OpenNext discussions", memberCount: 150000 },
    { slug: "reddit-aws", name: "r/aws", platform: "reddit", url: "https://reddit.com/r/aws", category: "cloud", audience: "AWS users and architects", relevance: "AWS cost optimization, NAT gateway complaints, migration discussions", memberCount: 300000 },
    { slug: "reddit-googlecloud", name: "r/googlecloud", platform: "reddit", url: "https://reddit.com/r/googlecloud", category: "cloud", audience: "GCP and Firebase users", relevance: "GCP/Firebase billing discussions, Cloud Run adoption", memberCount: 80000 },
    { slug: "reddit-azure", name: "r/azure", platform: "reddit", url: "https://reddit.com/r/azure", category: "cloud", audience: "Azure users and admins", relevance: "Azure cost management, App Service discussions", memberCount: 150000 },
    { slug: "reddit-cloudflare", name: "r/CloudFlare", platform: "reddit", url: "https://reddit.com/r/CloudFlare", category: "cloud", audience: "Cloudflare users", relevance: "Workers adoption, R2 migration stories, migration to Cloudflare", memberCount: 80000 },
    { slug: "reddit-sysadmin", name: "r/sysadmin", platform: "reddit", url: "https://reddit.com/r/sysadmin", category: "devops", audience: "System administrators", relevance: "Infrastructure decisions at scale, cloud vs on-prem debates", memberCount: 900000 },
    { slug: "reddit-homelab", name: "r/homelab", platform: "reddit", url: "https://reddit.com/r/homelab", category: "selfhosting", audience: "Homelab enthusiasts", relevance: "Self-hosting culture, VPS recommendations, Hetzner discussions", memberCount: 500000 },
    { slug: "reddit-terraform", name: "r/Terraform", platform: "reddit", url: "https://reddit.com/r/Terraform", category: "devops", audience: "Terraform and OpenTofu users", relevance: "IaC discussions, provider migrations, state management", memberCount: 60000 },
    { slug: "reddit-kubernetes", name: "r/kubernetes", platform: "reddit", url: "https://reddit.com/r/kubernetes", category: "devops", audience: "Kubernetes users", relevance: "Container orchestration, cloud cost debates, managed vs self-hosted K8s", memberCount: 200000 },
    { slug: "reddit-startups", name: "r/startups", platform: "reddit", url: "https://reddit.com/r/startups", category: "startup", audience: "Startup founders and early employees", relevance: "Infrastructure cost discussions, burn rate optimization", memberCount: 1000000 },
    { slug: "reddit-saas", name: "r/SaaS", platform: "reddit", url: "https://reddit.com/r/SaaS", category: "startup", audience: "SaaS builders", relevance: "Hosting cost optimization, scaling infrastructure discussions", memberCount: 100000 },
    { slug: "reddit-programming", name: "r/programming", platform: "reddit", url: "https://reddit.com/r/programming", category: "general", audience: "Software developers (broad)", relevance: "Viral cloud billing horror stories, migration blog post discussions", memberCount: 5000000 },

    // --- Hacker News ---
    { slug: "hn-front-page", name: "Hacker News", platform: "hackernews", url: "https://news.ycombinator.com", category: "general", audience: "Tech founders, senior engineers, VCs", relevance: "Viral billing stories ($96k Vercel, $70k Firebase, $85k GCP); migration blog posts regularly hit front page", notes: "Submit via Show HN or as link posts; comments drive most engagement" },
    { slug: "hn-show", name: "Show HN", platform: "hackernews", url: "https://news.ycombinator.com/show", category: "general", audience: "Tech founders and early adopters", relevance: "Launch new tools and migration stories; high-signal feedback" },
    { slug: "hn-ask", name: "Ask HN", platform: "hackernews", url: "https://news.ycombinator.com/ask", category: "general", audience: "Tech community (broad)", relevance: "Recurring threads: 'Why is Vercel so expensive?', 'How do you deploy?', 'What's your hosting stack?'" },

    // --- Stack Exchange ---
    { slug: "so-cloud", name: "Stack Overflow [cloud]", platform: "stackexchange", url: "https://stackoverflow.com/questions/tagged/cloud", category: "cloud", audience: "Developers seeking technical answers", relevance: "Cloud migration how-to questions, provider-specific troubleshooting" },
    { slug: "serverfault", name: "Server Fault", platform: "stackexchange", url: "https://serverfault.com", category: "devops", audience: "System administrators and network engineers", relevance: "Server migration questions, DNS cutover procedures, load balancer configs" },
    { slug: "devops-se", name: "DevOps Stack Exchange", platform: "stackexchange", url: "https://devops.stackexchange.com", category: "devops", audience: "DevOps practitioners", relevance: "IaC questions, CI/CD pipeline migration, deployment strategies" },
    { slug: "softwareeng-se", name: "Software Engineering SE", platform: "stackexchange", url: "https://softwareengineering.stackexchange.com", category: "general", audience: "Software architects and senior developers", relevance: "Architecture decisions around cloud providers, vendor lock-in discussions" },

    // --- Discord ---
    { slug: "discord-cloudflare", name: "Cloudflare Workers Discord", platform: "discord", url: "https://discord.cloudflare.com", category: "cloud", audience: "Cloudflare Workers developers", relevance: "Workers community, migration help, R2 adoption stories" },
    { slug: "discord-nextjs", name: "Next.js Discord", platform: "discord", url: "https://nextjs.org/discord", category: "frontend", audience: "Next.js developers", relevance: "Self-hosting Next.js discussions, Vercel alternative threads" },
    { slug: "discord-coolify", name: "Coolify Discord", platform: "discord", url: "https://coolify.io/discord", category: "selfhosting", audience: "Coolify users and self-hosters", relevance: "Self-hosting PaaS community; many Vercel/Heroku/Netlify refugees", notes: "Very active; good for understanding migration pain points" },
    { slug: "discord-railway", name: "Railway Discord", platform: "discord", url: "https://discord.gg/railway", category: "cloud", audience: "Railway users", relevance: "Railway pricing discussions, deployment help" },
    { slug: "discord-render", name: "Render Community", platform: "discord", url: "https://discord.gg/render", category: "cloud", audience: "Render users", relevance: "Render users discussing pricing, Heroku migration" },
    { slug: "discord-flyio", name: "Fly.io Community", platform: "discord", url: "https://community.fly.io", category: "cloud", audience: "Fly.io users", relevance: "Heroku migration stories, Fly Postgres discussions", notes: "Uses Discourse forum, not Discord" },
    { slug: "discord-neon", name: "Neon Discord", platform: "discord", url: "https://neon.tech/discord", category: "cloud", audience: "Neon Postgres users", relevance: "Postgres migration discussions, Heroku Postgres refugees" },
    { slug: "discord-hetzner", name: "Hetzner Community", platform: "discord", url: "https://discord.gg/hetzner", category: "selfhosting", audience: "Hetzner users", relevance: "VPS setup, cloud-to-VPS migration discussions, cost comparisons" },

    // --- Slack ---
    { slug: "slack-sweetops", name: "SweetOps (Cloud Posse)", platform: "slack", url: "https://slack.sweetops.com", category: "devops", audience: "DevOps engineers (9k+ members)", relevance: "AWS infrastructure discussions, Terraform best practices, Cloud Posse weekly office hours", memberCount: 9000 },
    { slug: "slack-devops", name: "DevOps Community Slack", platform: "slack", url: "https://devopscommunity.slack.com", category: "devops", audience: "DevOps practitioners (19k+ members)", relevance: "Infrastructure discussions, cloud provider comparisons", memberCount: 19000 },
    { slug: "slack-kubernetes", name: "Kubernetes Slack", platform: "slack", url: "https://slack.k8s.io", category: "devops", audience: "Kubernetes community", relevance: "K8s migration discussions, managed vs self-hosted debates" },
    { slug: "slack-heavybit", name: "Heavybit Developer Community", platform: "slack", url: "https://heavybit.com/community", category: "startup", audience: "Developer-focused startup founders", relevance: "Infrastructure cost discussions for developer tools companies" },

    // --- Forums / Blogs ---
    { slug: "dev-to", name: "DEV Community", platform: "forum", url: "https://dev.to", category: "general", audience: "Developers (broad)", relevance: "'Why I left Vercel' blog posts, hosting tutorials, self-hosting guides; high SEO value", notes: "Cross-post migration case studies here for reach" },
    { slug: "hashnode", name: "Hashnode", platform: "blog", url: "https://hashnode.com", category: "general", audience: "Developer bloggers", relevance: "Developer blogs about cloud migration, hosting comparisons" },
    { slug: "lobsters", name: "Lobsters", platform: "forum", url: "https://lobste.rs", category: "general", audience: "Senior engineers (invite-only)", relevance: "HN alternative with higher signal; infrastructure and DevOps discussions", notes: "Invite-only; higher quality discussion than HN" },
    { slug: "lowendtalk", name: "LowEndTalk", platform: "forum", url: "https://lowendtalk.com", category: "selfhosting", audience: "Budget hosting enthusiasts", relevance: "VPS deals, Hetzner discussions, hosting cost optimization; Serverborse auction talk", notes: "Very price-sensitive audience, good for VPS migration target messaging" },
    { slug: "indie-hackers", name: "Indie Hackers", platform: "forum", url: "https://indiehackers.com", category: "startup", audience: "Solo founders and indie developers", relevance: "Hosting cost discussions, bootstrap-friendly infrastructure" },
    { slug: "producthunt", name: "Product Hunt", platform: "forum", url: "https://producthunt.com", category: "startup", audience: "Product builders and early adopters", relevance: "Launch infralift here; new hosting products and migration tools get attention" },
    { slug: "tldr-newsletter", name: "TLDR Newsletter", platform: "blog", url: "https://tldr.tech", category: "general", audience: "Tech professionals (1M+ subscribers)", relevance: "DevOps/cloud news aggregator; sponsor or get featured for reach", memberCount: 1000000 },
    { slug: "changelog", name: "The Changelog", platform: "blog", url: "https://changelog.com", category: "general", audience: "Open source developers and DevOps practitioners", relevance: "Developer podcast/newsletter covering infrastructure topics" },

    // --- Vendor Communities ---
    { slug: "vercel-discussions", name: "Vercel GitHub Discussions", platform: "vendor", url: "https://github.com/vercel/next.js/discussions", category: "frontend", audience: "Vercel/Next.js users", relevance: "Pricing complaints, self-hosting questions, migration threads" },
    { slug: "heroku-forums", name: "Heroku Community", platform: "vendor", url: "https://community.heroku.com", category: "cloud", audience: "Heroku users", relevance: "End-of-life discussions, migration planning, alternative recommendations" },
    { slug: "firebase-community", name: "Firebase Google Group", platform: "vendor", url: "https://groups.google.com/g/firebase-talk", category: "cloud", audience: "Firebase developers", relevance: "Billing issues, Firestore pricing complaints, migration planning" },
    { slug: "digitalocean-community", name: "DigitalOcean Community", platform: "vendor", url: "https://community.digitalocean.com", category: "cloud", audience: "DigitalOcean users", relevance: "Migration tutorials, hosting guides, community Q&A" },
    { slug: "aws-repost", name: "AWS re:Post", platform: "vendor", url: "https://repost.aws", category: "cloud", audience: "AWS users", relevance: "Cost optimization Q&A, migration assistance, service comparisons" },
    { slug: "netlify-community", name: "Netlify Community Forum", platform: "vendor", url: "https://answers.netlify.com", category: "frontend", audience: "Netlify users", relevance: "Pricing questions, build minute concerns, alternative discussions" },
  ];

  for (const c of communities) {
    await prisma.communitySource.upsert({
      where: { slug: c.slug },
      create: c,
      update: {
        name: c.name,
        platform: c.platform,
        url: c.url,
        category: c.category,
        audience: c.audience,
        relevance: c.relevance,
        memberCount: c.memberCount ?? null,
        notes: c.notes ?? null,
      },
    });
  }

  console.log(
    `Seeded ${providers.length} hosting providers, ${programs.length} discount programs, ${tfTemplates.length} TF templates, ${communities.length} community sources`
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
