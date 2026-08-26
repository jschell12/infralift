import type { IacStandardCheck } from "@infralift/shared";

// The standards we enforce on every migration deliverable. Live per-workspace
// evaluation lands with the TF Cloud integration; this page documents the
// ruleset customers are held to.
const STANDARDS: IacStandardCheck[] = [
  {
    key: "remote_state",
    title: "Remote state in Terraform Cloud",
    description:
      "No local state files. Every root module uses a TF Cloud workspace with state locking and versioning.",
    status: "pass",
  },
  {
    key: "module_structure",
    title: "Standard module structure",
    description:
      "environments/ for root modules, modules/ for reusable components. No resources defined at repo root.",
    status: "pass",
  },
  {
    key: "naming",
    title: "Consistent naming & tagging",
    description:
      "Resources named {project}-{env}-{component}; every taggable resource carries project, environment, and managed_by tags.",
    status: "pass",
  },
  {
    key: "review_gates",
    title: "Plan-before-apply review gates",
    description:
      "Applies only run from VCS-triggered TF Cloud runs after a reviewed plan. No terraform apply from laptops.",
    status: "pass",
  },
  {
    key: "no_secrets",
    title: "No secrets in code or state where avoidable",
    description:
      "Secrets flow through TF Cloud sensitive variables or a secrets manager, never committed to the repo.",
    status: "pass",
  },
  {
    key: "drift",
    title: "Drift detection enabled",
    description:
      "Scheduled speculative plans detect console changes; drift surfaces in the Workspaces view.",
    status: "warn",
    detail: "Enabled per-workspace during migration handoff.",
  },
  {
    key: "pinned_versions",
    title: "Pinned provider & module versions",
    description:
      "Providers use ~> version constraints; modules are pinned to tags. Upgrades are deliberate, reviewed changes.",
    status: "pass",
  },
];

const BADGE: Record<IacStandardCheck["status"], string> = {
  pass: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-accent-dim text-accent",
  fail: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-danger/20 text-danger",
  warn: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-warn/20 text-warn",
  not_applicable: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-border text-muted",
};

export default function StandardsPage() {
  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight mb-2">IaC standards</h1>
      <p className="text-muted mb-8">
        Every deliverable is held to this ruleset. After migration, the
        platform keeps enforcing it, so your infrastructure stays reviewable,
        reproducible, and drift-free.
      </p>

      {STANDARDS.map((s) => (
        <div className="bg-surface border border-border rounded-xl p-6 mb-4" key={s.key}>
          <h3 className="text-base font-semibold mb-1.5">
            {s.title}{" "}
            <span className={BADGE[s.status]}>
              {s.status === "not_applicable" ? "n/a" : s.status}
            </span>
          </h3>
          <p className="text-muted text-sm">{s.description}</p>
          {s.detail && <p className="text-muted text-sm mt-1.5">{s.detail}</p>}
        </div>
      ))}
    </>
  );
}
