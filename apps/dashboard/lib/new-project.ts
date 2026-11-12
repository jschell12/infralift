// The starting points /projects/new offers, in the order ADR 0010 sets
// (docs/adr/0010-a-project-is-one-accounts-infrastructure.md), and the
// translation from the links that used to open the new-project drawer.

export type StartingPoint = "adopt" | "stack" | "terraform";

export const STARTING_POINTS: { key: StartingPoint; title: string; body: string }[] = [
  {
    key: "adopt",
    title: "Adopt from an account",
    body: "Pick a connected cloud account. infralift lists what it runs, and you choose what to bring under Terraform. Nothing running changes.",
  },
  {
    key: "stack",
    title: "Start from a stack",
    body: "Render a stack of modules, such as a database with backups or a network baseline, into your repository as a pull request.",
  },
  {
    key: "terraform",
    title: "Bring existing Terraform",
    body: "Point at a repository directory that already holds Terraform. It comes under infralift once a read-only plan changes nothing.",
  },
];

export function startingPointOf(value: string | null | undefined): StartingPoint | null {
  return STARTING_POINTS.find((s) => s.key === value)?.key ?? null;
}

/** The new-project URL for a link that used to open the drawer on /projects,
 *  or null when the query asks for nothing. ?start=existing and
 *  ?assess=<connectionId> were the existing-infrastructure path, which is now
 *  "adopt"; ?start=import is "terraform"; ?start=template is "stack". */
export function legacyNewProjectUrl(search: string): string | null {
  const q = new URLSearchParams(search);
  const start = q.get("start");
  const assess = q.get("assess");
  if (assess) return `/projects/new?start=adopt&assess=${encodeURIComponent(assess)}`;
  if (start === "existing") return "/projects/new?start=adopt";
  if (start === "import") return "/projects/new?start=terraform";
  if (start === "template") return "/projects/new?start=stack";
  return null;
}
