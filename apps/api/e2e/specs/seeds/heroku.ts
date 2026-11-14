// The Heroku account Prism serves (sources.ts "heroku"). Only the fields
// packages/collectors/heroku.mjs reads, plus what makes a record
// recognizable; extract.ts fills the rest from the response schema and
// checks the example against it. Prism answers every app's formation and
// add-ons with the same lists, so the seed has one app.

export const HEROKU_SEED = {
  app: { id: "e2e0a0a0-0000-4000-8000-000000000101", name: "infralift-e2e-app" },
  dyno: { type: "web", size: "Basic", quantity: 1 },
  addon: { id: "e2e0a0a0-0000-4000-8000-000000000102", name: "postgresql-e2e-12345" },
} as const;

export const HEROKU_EXAMPLES: Record<string, unknown> = {
  "/account": { id: "e2e0a0a0-0000-4000-8000-0000000001aa", email: "e2e@infralift-e2e-heroku.example" },
  "/apps": [
    {
      id: HEROKU_SEED.app.id,
      name: HEROKU_SEED.app.name,
      region: { id: "59accabd-516d-4f0e-83e6-6e3757701145", name: "us" },
      stack: { id: "74cfe988-7527-4ca9-9667-77bb9f3029cf", name: "heroku-24" },
      maintenance: false,
    },
  ],
  "/apps/{app_id_or_name}/formation": [{ type: HEROKU_SEED.dyno.type, size: HEROKU_SEED.dyno.size, quantity: HEROKU_SEED.dyno.quantity }],
  "/apps/{app_id_or_name}/addons": [
    {
      id: HEROKU_SEED.addon.id,
      name: HEROKU_SEED.addon.name,
      addon_service: { id: "6c67493d-8fc2-4cd4-9161-4f1ec11cbe69", name: "heroku-postgresql" },
      plan: { id: "a1c2e1b4-2e3b-4b5c-9b64-1b2c3d4e5f60", name: "heroku-postgresql:essential-0" },
      billed_price: { cents: 500, contract: false, unit: "month" },
    },
  ],
};
