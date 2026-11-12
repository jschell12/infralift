"use client";

// The resource list on /projects/new/adopt: what a cloud account runs that no
// infralift project manages, one tile per resource type, each resource a
// checkbox. Resources infralift cannot adopt yet are shown, disabled, with the
// reason, so the list matches the account rather than hiding the gaps.
//
// Selection state lives in the page; this renders it. Grouping and the
// select-all rules are in lib/adopt-account.ts.

import { useEffect, useId, useRef } from "react";
import { inventoryTypeLabel, type UnmanagedResource } from "@infralift/shared";
import { groupSelection, resourceKey, type ResourceGroup } from "../lib/adopt-account";
import { CARD, MONO, NUM } from "./ui";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text";
const CHECKBOX = `h-5 w-5 shrink-0 cursor-pointer accent-text disabled:cursor-default ${FOCUS}`;

/** A native checkbox that can also show the mixed state, which has no HTML
 *  attribute and is set on the element instead. The indeterminate property
 *  is what assistive tech reads as mixed, so no aria-checked on top. */
function Checkbox({
  checked,
  mixed = false,
  disabled = false,
  onChange,
  describedBy,
  id,
}: {
  checked: boolean;
  mixed?: boolean;
  disabled?: boolean;
  onChange: () => void;
  describedBy?: string;
  id?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={ref}
      id={id}
      type="checkbox"
      className={CHECKBOX}
      checked={checked}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={onChange}
    />
  );
}

function ResourceRow({
  r,
  checked,
  onToggle,
}: {
  r: UnmanagedResource;
  checked: boolean;
  onToggle: () => void;
}) {
  const reasonId = useId();
  return (
    <li>
      <label
        className={`flex min-h-11 items-start gap-3 rounded-lg px-2 py-2.5 ${r.adoptable ? "cursor-pointer hover:bg-bg active:bg-border/60" : "cursor-default"}`}
      >
        <span className="flex h-6 items-center">
          <Checkbox
            checked={checked}
            disabled={!r.adoptable}
            onChange={onToggle}
            describedBy={r.adoptable ? undefined : reasonId}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block text-sm font-semibold break-words ${r.adoptable ? "text-text" : "text-muted"}`}>
            {r.name}
          </span>
          <span className={`block text-xs text-muted break-all ${MONO}`}>{r.providerId}</span>
          <span className="block text-xs text-muted">
            {r.region ?? "No region"}
            {r.adoptable && r.terraformType ? (
              <>
                {" · imports as "}
                <span className={MONO}>{r.terraformType}</span>
              </>
            ) : null}
          </span>
          {!r.adoptable && (
            <span id={reasonId} className="mt-1 block text-xs text-text">
              Can&apos;t adopt yet: {r.reason ?? "infralift has no import for this type."}
            </span>
          )}
        </span>
      </label>
    </li>
  );
}

function GroupTile({
  group,
  selected,
  onToggle,
  onToggleGroup,
}: {
  group: ResourceGroup;
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onToggleGroup: (group: ResourceGroup) => void;
}) {
  const headingId = useId();
  const allId = useId();
  const state = groupSelection(group, selected);
  const pickedHere = group.adoptableKeys.filter((k) => selected.has(k)).length;
  const blocked = group.resources.length - group.adoptableKeys.length;
  return (
    <li className={`${CARD} min-w-0 p-4 sm:p-5`}>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 id={headingId} className="min-w-0 flex-1 text-sm font-semibold break-words">
          {inventoryTypeLabel(group.type)}
        </h3>
        <span className={`text-xs text-muted ${NUM}`}>
          {group.resources.length} found
          {blocked ? ` · ${blocked} can't be adopted yet` : ""}
        </span>
      </div>
      {group.adoptableKeys.length > 0 && (
        <div className="mb-1 flex min-h-11 items-center gap-3 border-b border-border px-2 pb-1">
          <Checkbox
            id={allId}
            checked={state === "all"}
            mixed={state === "some"}
            onChange={() => onToggleGroup(group)}
          />
          <label htmlFor={allId} className={`flex-1 cursor-pointer text-[13px] font-semibold text-muted ${NUM}`}>
            Select all {group.adoptableKeys.length}
            {pickedHere ? ` (${pickedHere} selected)` : ""}
          </label>
        </div>
      )}
      <ul aria-labelledby={headingId}>
        {group.resources.map((r) => {
          const key = resourceKey(r);
          return <ResourceRow key={key} r={r} checked={selected.has(key)} onToggle={() => onToggle(key)} />;
        })}
      </ul>
    </li>
  );
}

/** The groups as a list of tiles. */
export function UnmanagedPicker({
  groups,
  selected,
  onToggle,
  onToggleGroup,
}: {
  groups: ResourceGroup[];
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onToggleGroup: (group: ResourceGroup) => void;
}) {
  return (
    <ul aria-label="Unmanaged resources by type" className="flex flex-col gap-4">
      {groups.map((g) => (
        <GroupTile key={g.type} group={g} selected={selected} onToggle={onToggle} onToggleGroup={onToggleGroup} />
      ))}
    </ul>
  );
}
