/**
 * Firebase Cloud Function adapter for the infralift-demo Express app.
 *
 * This wraps the Express app from the reference-app as a v2 Cloud Function
 * so Firebase Hosting can route all requests to it.
 */
const { onRequest } = require("firebase-functions/v2/https");

// The reference app's server.js exports nothing by default (it calls
// app.listen), so we require its components directly. The deploy script
// copies the reference app into this directory before deploying.
const express = require("express");
const { readFileSync } = require("fs");
const { join } = require("path");
const { Pool } = require("pg");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const provider = process.env.PROVIDER_NAME || "firebase";

// Postgres -- use an external provider (Neon recommended) since Firebase
// does not offer managed Postgres. Set DATABASE_URL in Firebase config:
//   firebase functions:config:set db.url="postgres://..."
// Or use firebase functions:secrets for v2 functions.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Object storage (S3-compatible, optional)
const s3 = process.env.STORAGE_ENDPOINT
  ? new S3Client({
      endpoint: process.env.STORAGE_ENDPOINT,
      region: process.env.STORAGE_REGION || "auto",
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY || "",
        secretAccessKey: process.env.STORAGE_SECRET_KEY || "",
      },
      forcePathStyle: true,
    })
  : null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const template = readFileSync(join(__dirname, "views/index.html"), "utf8");

// Static files
app.use("/public", express.static(join(__dirname, "public")));

// Homepage
app.get("/", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM demo_items ORDER BY id");
    const itemsHtml = rows
      .map((r) => `<li><strong>${r.name}</strong>: ${r.description}</li>`)
      .join("\n");
    const html = template
      .replace("{{provider}}", provider)
      .replace("{{items}}", itemsHtml)
      .replace("{{count}}", String(rows.length));
    res.type("html").send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// JSON API
app.get("/api/status", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT count(*) AS n FROM demo_items");
    res.json({
      status: "ok",
      provider,
      timestamp: new Date().toISOString(),
      itemCount: Number(rows[0].n),
    });
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

// File upload
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!s3) return res.status(501).json({ error: "Object storage not configured" });
  if (!req.file) return res.status(400).json({ error: "No file provided" });
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.STORAGE_BUCKET,
        Key: `uploads/${Date.now()}-${req.file.originalname}`,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      })
    );
    res.json({ uploaded: true, filename: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/health", (_req, res) => res.json({ healthy: true }));

// Export the Express app as a v2 Cloud Function
exports.app = onRequest(app);
