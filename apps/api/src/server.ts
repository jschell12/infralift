import express from "express";
import cors from "cors";
import { authRouter } from "./routes/auth.js";
import { connectionsRouter } from "./routes/connections.js";
import { assessmentsRouter } from "./routes/assessments.js";
import { migrationsRouter } from "./routes/migrations.js";
import { workspacesRouter } from "./routes/workspaces.js";
import { providersRouter } from "./routes/providers.js";
import { tfRouter } from "./routes/tf.js";
import { communitiesRouter } from "./routes/communities.js";

const app = express();

const corsOrigins = (process.env.CORS_ORIGINS ??
  "http://localhost:3000,http://localhost:3001")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({ origin: corsOrigins }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/connections", connectionsRouter);
app.use("/assessments", assessmentsRouter);
app.use("/migrations", migrationsRouter);
app.use("/workspaces", workspacesRouter);
app.use("/hosting", providersRouter);
app.use("/tf", tfRouter);
app.use("/communities", communitiesRouter);

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`infralift api listening on :${port}`);
});
