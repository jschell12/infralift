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

  console.log(
    `Seeded ${providers.length} hosting providers, ${programs.length} discount programs, ${tfTemplates.length} TF templates`
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
