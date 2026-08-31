// Outbound links shared across the marketing site.
//
// DASHBOARD_URL was declared separately in page.tsx, leaving/[provider]/page.tsx
// and docs/layout.tsx. Two of them defaulted to production and one to
// localhost, so every docs page shipped a "Start assessment" button pointing at
// http://localhost:3001. That is the second time this constant has drifted, so
// it lives in one place now.
export const DASHBOARD_URL =
  process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://dashboard.infralift.dev";
