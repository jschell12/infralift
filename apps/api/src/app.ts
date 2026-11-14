import express from "express";
import cors from "cors";
import { cfAuth, requireAdmin } from "./lib/cf-auth.js";
import { connectionsRouter } from "./routes/connections.js";
import { assessmentsRouter } from "./routes/assessments.js";
import { migrationsRouter } from "./routes/migrations.js";
import { workspacesRouter } from "./routes/workspaces.js";
import { providersRouter } from "./routes/providers.js";
import { tfRouter } from "./routes/tf.js";
import { importsRouter } from "./routes/imports.js";
import { adminStacksRouter, teamStacksRouter } from "./routes/team-stacks.js";
import { communitiesRouter } from "./routes/communities.js";
import { leadsRouter } from "./routes/leads.js";
import { intakeRouter } from "./routes/intake.js";
import { estimateRouter } from "./routes/estimate.js";
import { analyticsRouter } from "./routes/analytics.js";
import { catchAsyncErrors, errorHandler } from "./lib/async-errors.js";
import { bindUserToRequestContext, requestContext, restoreRequestContext } from "./lib/request-context.js";
import { JSON_BODY_LIMIT, requireJsonBody } from "./lib/json-body.js";
import { checkReadiness } from "./lib/readiness.js";

export const app = express();

const corsOrigins = (process.env.CORS_ORIGINS ??
  "http://localhost:3000,http://localhost:3001")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// First: every request gets an id (echoed as X-Request-Id), a log context and
// an access line (lib/request-context.ts), including requests refused below.
app.use(requestContext());
app.use(cors({ origin: corsOrigins, credentials: true }));
// Bodies are JSON (415 otherwise) and at most JSON_BODY_LIMIT (413).
app.use(requireJsonBody);
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(restoreRequestContext);

// Liveness: the process answers. Readiness: it can reach the database
// (lib/readiness.ts). Neither needs authentication.
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/ready", async (_req, res) => {
  const readiness = await checkReadiness();
  res.status(readiness.ok ? 200 : 503).json(readiness);
});

// Public lead intake, deliberately registered above cfAuth. Registration
// order is the only mechanism for a public route here — cfAuth has no
// allowlist — so this must stay above the app.use(cfAuth) line below.
//
// Note this is necessary but not sufficient: api.infralift.dev also sits
// behind a Cloudflare Access application, which rejects the request before
// Express sees it. Reaching this route from the public internet needs an
// Access bypass policy for the path, configured outside this repo.
app.use("/intake/lead", intakeRouter);

// Public cost estimator, same reasoning and the same Access caveat: this path
// needs its own Access application in schellout, because the lead-intake one is
// scoped to /intake/lead exactly. It is a pure function over the request body:
// no reads, no writes, no tenant.
app.use("/intake/estimate", estimateRouter);

// All routes below require Cloudflare Access authentication.
// In dev mode (no CF_ACCESS_TEAM_DOMAIN), a dev user is auto-created.
app.use(cfAuth);
app.use(bindUserToRequestContext);

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
app.use("/tf/imports", importsRouter);
app.use("/tf", tfRouter);
app.use("/stacks", teamStacksRouter);

// Admin-only routes
app.use("/communities", requireAdmin, communitiesRouter);
app.use("/leads", requireAdmin, leadsRouter);
app.use("/analytics", requireAdmin, analyticsRouter);
app.use("/admin/stacks", requireAdmin, adminStacksRouter);

// Must stay last: wraps every handler registered above so a rejected async
// handler reaches errorHandler instead of exiting the process. A route
// registered after this line is not covered.
catchAsyncErrors(app);
app.use(errorHandler);
