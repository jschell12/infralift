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
  console.log(`Seeded ${providers.length} hosting providers`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
