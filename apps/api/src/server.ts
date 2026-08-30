import express from "express";
import cors from "cors";
import { cfAuth, requireAdmin } from "./lib/cf-auth.js";
import { connectionsRouter } from "./routes/connections.js";
import { assessmentsRouter } from "./routes/assessments.js";
import { migrationsRouter } from "./routes/migrations.js";
import { workspacesRouter } from "./routes/workspaces.js";
import { providersRouter } from "./routes/providers.js";
import { tfRouter } from "./routes/tf.js";
import { communitiesRouter } from "./routes/communities.js";
import { leadsRouter } from "./routes/leads.js";
import { analyticsRouter } from "./routes/analytics.js";
import { startAnalyticsRollup } from "./analytics/rollup.js";

const app = express();

const corsOrigins = (process.env.CORS_ORIGINS ??
  "http://localhost:3000,http://localhost:3001")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// All routes below require Cloudflare Access authentication.
// In dev mode (no CF_ACCESS_TEAM_DOMAIN), a dev user is auto-created.
app.use(cfAuth);

// Current user info — the dashboard calls this on load.
app.get("/auth/me", (req, res) => {
  res.json(req.user);
});

// Customer-facing routes (scoped to req.user.orgId by each router)
app.use("/connections", connectionsRouter);
app.use("/assessments", assessmentsRouter);
app.use("/migrations", migrationsRouter);
app.use("/workspaces", workspacesRouter);
app.use("/hosting", providersRouter);
app.use("/tf", tfRouter);

// Admin-only routes
app.use("/communities", requireAdmin, communitiesRouter);
app.use("/leads", requireAdmin, leadsRouter);
app.use("/analytics", requireAdmin, analyticsRouter);

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`infralift api listening on :${port}`);
  startAnalyticsRollup();
});
