// Outbound links shared across the marketing site.
//
// DASHBOARD_URL was declared separately in page.tsx, leaving/[provider]/page.tsx
// and docs/layout.tsx. Two of them defaulted to production and one to
// localhost, so every docs page shipped a "Start assessment" button pointing at
// http://localhost:3001. That is the second time this constant has drifted, so
// it lives in one place now.
export const DASHBOARD_URL =
  process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://dashboard.infralift.dev";

/** Whether to render the lead form instead of linking to the dashboard.
 *
 * The dashboard sits behind Cloudflare Access, so for anyone without an
 * account the "free assessment" CTA is a login wall. The form fixes that, but
 * it only works once the Worker has LEAD_INTAKE_URL set and the API's
 * /intake/lead path is reachable from the public internet. Until both are
 * true this stays off and the CTA keeps its old behaviour, so a half-wired
 * deploy cannot start dropping leads on the floor.
 */
export const LEAD_FORM_ENABLED =
  process.env.NEXT_PUBLIC_LEAD_FORM_ENABLED === "true";
