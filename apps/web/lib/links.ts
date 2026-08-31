// Outbound links shared across the marketing site.
//
// DASHBOARD_URL was declared separately in page.tsx, leaving/[provider]/page.tsx
// and docs/layout.tsx. Two of them defaulted to production and one to
// localhost, so every docs page shipped a "Start assessment" button pointing at
// http://localhost:3001. That is the second time this constant has drifted, so
// it lives in one place now.
export const DASHBOARD_URL =
  process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://dashboard.infralift.dev";

/** Whether to render the lead form underneath the sign-in CTA.
 *
 * This used to decide whether the "free assessment" CTA was a form or a link
 * to the dashboard, because the dashboard was a login wall: Cloudflare Access
 * let exactly one email through, so everyone else got a login page and then a
 * refusal. That is no longer true. The Access app now allows any Google or
 * GitHub sign-in (schellout PR #284), so the CTA is a real signup and the form
 * is the secondary path for people who would rather not connect an account
 * yet.
 *
 * It stays a flag because the form still needs LEAD_INTAKE_URL and the two
 * LEAD_INTAKE_CF_* service-token halves set as Worker secrets. Without them
 * /a/lead answers 503, and a submit button that always fails is worse than no
 * form at all. Turning it on is documented in the README.
 */
export const LEAD_FORM_ENABLED =
  process.env.NEXT_PUBLIC_LEAD_FORM_ENABLED === "true";
