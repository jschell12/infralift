// One connection as a tile: what it is, its status, when it last verified, and
// why it is invalid if it is. Used wherever connections are shown, so each
// connection is its own tile in a grid rather than a row inside one card:
// /connections (with verify, replace and remove), the dashboard home (the
// whole tile links to /connections) and the adopt step of /projects/new (with
// that account's assessment and its actions).

import type { ReactNode } from "react";
import type { ProviderConnectionSummary } from "@infralift/shared";
import { connectionName, connectionStatus } from "../lib/connections";
import { CARD, Chip } from "./ui";

/** The responsive grid the tiles sit in: 1, 2 or 3 columns. */
export const CONNECTION_GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text";

function formatVerified(iso: string | null): string {
  if (!iso) return "Not verified yet";
  return `Last verified ${new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`;
}

function TileBody({ c, children }: { c: ProviderConnectionSummary; children?: ReactNode }) {
  const status = connectionStatus(c);
  return (
    <>
      <div className="mb-1 flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-base font-semibold break-words">{connectionName(c.provider)}</h2>
        <Chip tone={status.tone}>{status.text}</Chip>
      </div>
      <div className="mb-1 text-sm text-muted break-words">{c.label}</div>
      <div className="text-xs text-faint">{formatVerified(c.lastVerifiedAt)}</div>
      {c.status === "invalid" && c.lastError && <div className="mt-2 text-xs text-danger break-words">{c.lastError}</div>}
      {children}
    </>
  );
}

/**
 * A connection tile, rendered as a list item, so put it in a <ul> with
 * CONNECTION_GRID.
 *
 * Pass `href` to make the whole tile a link (no actions then, since a button
 * cannot sit inside a link), or `actions` for a row of buttons pinned to the
 * bottom of the tile. `children` go under the status lines.
 */
export function ConnectionTile(
  props: { c: ProviderConnectionSummary; children?: ReactNode } & (
    | { href: string; actions?: never }
    | { href?: never; actions?: ReactNode }
  )
) {
  const { c, children } = props;
  if (props.href) {
    return (
      <li className="min-w-0">
        <a
          href={props.href}
          className={`${CARD} block h-full p-5 text-text hover:border-control active:bg-bg ${FOCUS}`}
        >
          <TileBody c={c}>{children}</TileBody>
        </a>
      </li>
    );
  }
  return (
    <li className={`${CARD} flex min-w-0 flex-col p-5`}>
      <TileBody c={c}>{children}</TileBody>
      {props.actions ? <div className="mt-auto pt-4">{props.actions}</div> : null}
    </li>
  );
}
