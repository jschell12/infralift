"use client";

import {
  Card,
  CardTitle,
  Chip,
  Dot,
  H1,
  NUM,
  StatCard,
  TableHead,
  TableRow,
  TableScroll,
  type Tone,
} from "../components/ui";

/* TODO(api): /admin/deals and /admin/queue don't exist yet. Fixtures below keep
 * the screen honest about its shape; swap for api<T>() calls when they land. */

const STATS = [
  { label: "Assessments run", value: "38", sub: "+6 this week", tone: "muted" as Tone },
  { label: "Quote \u2192 signed", value: "31%", sub: "12 of 38", tone: "accent" as Tone },
  { label: "Migrations in flight", value: "4", sub: "1 cutover this week", tone: "warn" as Tone },
  { label: "Fees booked (Q3)", value: "$46.2k", sub: "avg fee $4,850", tone: "accent" as Tone },
];

type Stage = "assessing" | "quote sent" | "migrating" | "cutover" | "lost";

const STAGE_TONE: Record<Stage, Tone> = {
  assessing: "muted",
  "quote sent": "warn",
  migrating: "accent",
  cutover: "info",
  lost: "danger",
};

const DEALS: {
  org: string;
  id: string;
  stage: Stage;
  source: string;
  fee: string;
  saved: string;
}[] = [
  { org: "Northwind Labs", id: "org_8f21", stage: "quote sent", source: "r/nextjs", fee: "$4,200", saved: "$641" },
  { org: "Fernwood Health", id: "org_7b04", stage: "migrating", source: "inbound", fee: "$6,800", saved: "$1,120" },
  { org: "Basil & Co", id: "org_6c93", stage: "assessing", source: "HN", fee: "\u2014", saved: "\u2014" },
  { org: "Loom Analytics", id: "org_5a18", stage: "migrating", source: "referral", fee: "$5,400", saved: "$780" },
  { org: "Tidewater API", id: "org_4d77", stage: "cutover", source: "r/heroku", fee: "$3,000", saved: "$412" },
  { org: "Palladium AI", id: "org_3e52", stage: "lost", source: "Lobsters", fee: "\u2014", saved: "\u2014" },
];

const QUEUE: { id: string; provider: string; age: string; state: "running" | "done" | "error" }[] = [
  { id: "as_9f31", provider: "Vercel", age: "2m", state: "running" },
  { id: "as_9f2c", provider: "Heroku", age: "18m", state: "done" },
  { id: "as_9f19", provider: "Firebase", age: "1h", state: "error" },
  { id: "as_9ef8", provider: "AWS", age: "3h", state: "done" },
];

const QUEUE_TONE: Record<"running" | "done" | "error", Tone> = {
  running: "warn",
  done: "accent",
  error: "danger",
};

const DEAL_COLS = "grid-cols-[1.4fr_1fr_0.9fr_0.9fr_0.8fr]";

export default function AdminOverview() {
  return (
    <>
      <h1 className={H1}>Admin</h1>
      <p className="mb-7 text-muted">
        Pipeline, lead flow, and account health across the book.
      </p>

      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-4">
        {STATS.map((s) => (
          <StatCard key={s.label} {...s} />
        ))}
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardTitle>Deals in flight</CardTitle>
          <TableScroll min="min-w-[620px]">
            <TableHead cols={DEAL_COLS}>
              <span>Account</span>
              <span>Stage</span>
              <span>Source</span>
              <span>Fee</span>
              <span>Saved/mo</span>
            </TableHead>
            {DEALS.map((d) => (
              <TableRow key={d.id} cols={DEAL_COLS}>
                <div className="min-w-0">
                  <div className="text-sm">{d.org}</div>
                  <div className="font-mono text-[11px] text-faint">{d.id}</div>
                </div>
                <Chip tone={STAGE_TONE[d.stage]} size="xs">
                  {d.stage}
                </Chip>
                <span className="text-muted">{d.source}</span>
                <span className={NUM}>{d.fee}</span>
                <span className={`text-accent ${NUM}`}>{d.saved}</span>
              </TableRow>
            ))}
          </TableScroll>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardTitle>Assessment queue</CardTitle>
            <div className="flex flex-col gap-1.5">
              {QUEUE.map((q) => (
                <div
                  key={q.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-bg px-2.5 py-2 text-[13px]"
                >
                  <Dot tone={QUEUE_TONE[q.state]} />
                  <span className="font-mono text-xs">{q.id}</span>
                  <span className="text-muted">{q.provider}</span>
                  <span className={`ml-auto text-[11px] text-faint ${NUM}`}>
                    {q.age}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-3 border-t border-border pt-2.5 text-xs text-faint">
              Connector errors surface here before the customer sees them.
            </div>
          </Card>

          <Card>
            <CardTitle>Last scan</CardTitle>
            <div className="text-[26px] font-bold text-accent">41m ago</div>
            <p className="mt-1.5 text-[13px] text-muted">
              48 communities polled every 4 hours &middot; 6 platforms
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
