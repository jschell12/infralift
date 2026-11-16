import type { ProjectVersions, VersionItem, VersionStatus } from "@infralift/shared";
import { CARD, Chip, MONO, NUM, SMALL_BTN, type Tone } from "./ui";

// How far a project is behind (ADR 0012, phase 1), as GET /tf/versions sends
// it (apps/api/src/services/versions.ts). Status colour only where something
// is behind: a major release back is danger, a minor or patch is warn,
// current is the neutral check every other "fine" state on the dashboard
// uses, and unknown is plain text, because not knowing is not a failure.

export const VERSION_LOOK: Record<VersionStatus, { tone: Tone; text: string }> = {
  current: { tone: "ok", text: "current" },
  "behind-minor": { tone: "warn", text: "behind" },
  "behind-major": { tone: "danger", text: "major behind" },
  unknown: { tone: "faint", text: "unknown" },
};

export function VersionStatusChip({ status }: { status: VersionStatus }) {
  const look = VERSION_LOOK[status] ?? VERSION_LOOK.unknown;
  return <Chip tone={look.tone}>{look.text}</Chip>;
}

const behind = (s: VersionStatus) => s === "behind-minor" || s === "behind-major";

/** One line for a project card: the overall status and what is behind. */
export function versionSummaryText(v: ProjectVersions): string {
  if (!v.checkedAt) return "Versions not read yet.";
  if (v.problem) return v.problem;
  const parts: string[] = [];
  if (v.stack && behind(v.stack.status)) parts.push(`stack ${v.stack.have} of ${v.stack.want}`);
  if (v.terraform && behind(v.terraform.status)) parts.push(`required_version ${v.terraform.have}`);
  const providers = v.providers.filter((p) => behind(p.status)).length;
  if (providers) parts.push(`${providers} provider${providers > 1 ? "s" : ""} behind`);
  if (parts.length) return parts.join(" · ");
  if (v.status === "unknown") return "Some versions could not be compared.";
  return "Stack, Terraform and providers are current.";
}

/** The summary under a project on the projects page, linking to its row in
 *  the versions view. */
export function VersionSummary({ v }: { v: ProjectVersions | undefined }) {
  if (!v) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm mb-2.5">
      <VersionStatusChip status={v.status} />
      <span className="min-w-0 text-muted break-words">{versionSummaryText(v)}</span>
      <a className="ml-auto inline-flex min-h-11 items-center text-text underline text-sm font-semibold whitespace-nowrap" href={`/projects/versions#${v.projectId}`}>
        Versions
      </a>
    </div>
  );
}

function ItemRow({ item }: { item: VersionItem }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 py-2.5 border-t border-border first:border-t-0">
      <span className={`${MONO} text-sm break-all`}>{item.name}</span>
      <VersionStatusChip status={item.status} />
      <span className={`col-span-2 text-sm text-muted ${NUM}`}>
        {item.have ?? "not pinned"}
        {item.want ? ` · infralift ${item.want}` : ""}
      </span>
      {item.note ? <span className="col-span-2 text-sm text-muted break-words">{item.note}</span> : null}
    </li>
  );
}

/** One project in the versions view: every item with what it has, what
 *  infralift asks for and why anything is unknown. */
export function VersionCard({
  v,
  onCheck,
  checking = false,
  checkError = null,
}: {
  v: ProjectVersions;
  onCheck?: () => void;
  checking?: boolean;
  checkError?: string | null;
}) {
  const items = [...(v.stack ? [v.stack] : []), ...(v.terraform ? [v.terraform] : []), ...v.providers];
  return (
    <section id={v.projectId} className={`${CARD} mb-4 scroll-mt-4`} aria-labelledby={`${v.projectId}-name`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-1.5">
        <h2 id={`${v.projectId}-name`} className="text-base font-semibold">
          {v.name}
        </h2>
        <VersionStatusChip status={v.status} />
        {onCheck ? (
          <button type="button" className={`${SMALL_BTN} ml-auto`} onClick={onCheck} disabled={checking}>
            {checking ? "Checking..." : "Check now"}
          </button>
        ) : null}
      </div>
      <div className={`text-sm text-muted ${MONO} mb-3 break-all`}>
        {v.destRepo || "no repository"}
        {v.ref ? `@${v.ref}` : ""}
        {v.path ? ` · ${v.path}` : ""}
      </div>
      {checkError ? (
        <p role="alert" className="text-sm text-text mb-2">
          {checkError}
        </p>
      ) : null}
      {v.problem ? <p className="text-sm text-text mb-2 break-words">{v.problem}</p> : null}
      {items.length ? (
        <ul className="list-none p-0 m-0">
          {items.map((item) => (
            <ItemRow key={item.name} item={item} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">
          {v.checkedAt && v.terraform
            ? "No Terraform version or provider pins found."
            : "Not read yet. infralift reads each repository once a day."}
        </p>
      )}
      {v.notes.length ? <p className="text-sm text-muted mt-2 break-words">{v.notes.join(" ")}</p> : null}
      <p className={`text-xs text-muted mt-3 ${NUM}`}>
        {v.checkedAt ? `Read ${new Date(v.checkedAt).toLocaleString()}` : "Never read"}
      </p>
    </section>
  );
}
