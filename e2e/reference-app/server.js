const express = require("express");
const { readFileSync } = require("fs");
const { join } = require("path");
const { Pool } = require("pg");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const port = Number(process.env.PORT || 3000);
const provider = process.env.PROVIDER_NAME || "unknown";

// Postgres
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Object storage (S3-compatible)
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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const template = readFileSync(join(__dirname, "views/index.html"), "utf8");

// Static files
app.use("/public", express.static(join(__dirname, "public")));

// SSR-style homepage
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

// JSON API endpoint
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

// File upload to object storage
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

app.listen(port, () => {
  console.log(`infralift-demo (${provider}) listening on :${port}`);
});
