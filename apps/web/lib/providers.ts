// The providers the assessment can connect to today, in display order.
//
// The home page stat, its sentence and the site description each kept their
// own copy of this list, and they drifted to "12 providers" beside a list of
// eleven. They all read this one now.
//
// AWS is left out on purpose: the connector and the adopter exist, but AWS
// connections are not enabled on the production server, so a visitor who
// signs up cannot connect one yet. Add it here when they can.
export const ASSESSED_PROVIDERS = [
  "Vercel",
  "Heroku",
  "Firebase",
  "Google Cloud",
  "Azure",
  "Netlify",
  "Render",
  "Railway",
  "Fly.io",
  "DigitalOcean",
  "Cloudflare",
] as const;

/** "A, B, and C" */
export function listProviders(names: readonly string[] = ASSESSED_PROVIDERS): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** The providers adoption can import from, once connected. Same AWS caveat. */
export const ADOPTION_PROVIDERS = ["Cloudflare", "DigitalOcean", "Google Cloud", "Azure"] as const;
