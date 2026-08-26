const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS demo_items (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query("SELECT count(*) AS n FROM demo_items");
  if (Number(rows[0].n) > 0) {
    console.log("demo_items already seeded, skipping");
    await pool.end();
    return;
  }

  await pool.query(`
    INSERT INTO demo_items (name, description) VALUES
      ('Widget A', 'A small reusable component for dashboards'),
      ('Widget B', 'Real-time data visualization widget'),
      ('Service Alpha', 'Background job processor with retry logic'),
      ('Service Beta', 'Webhook relay with signature verification'),
      ('Library Core', 'Shared utility functions used across services')
  `);

  console.log("Seeded 5 demo_items");
  await pool.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
