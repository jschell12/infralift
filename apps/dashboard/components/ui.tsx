// Imported only by client components; Drawer uses hooks, so a server
// component must not render it directly.
import { useEffect, useId, useRef, type ReactNode } from "react";
import { trappedFocusTarget } from "../lib/focus";

/** The repeated utility strings, in one place. No transitions: hover is
 *  colour-only, per the design system. */

export const CARD = "bg-surface border border-border rounded-xl p-6";
export const NUM = "[font-variant-numeric:tabular-nums]";
export const MONO = "font-mono";
export const H1 = "text-[26px] font-bold tracking-[-0.02em] mb-1.5";
export const LEAD = "text-muted mb-7 max-w-[640px]";
export const LABEL = "block text-[13px] font-semibold text-muted mb-1.5";
/** 16px text, not 14: iOS Safari zooms the whole page when a focused field's
 *  text is under 16px, and does not zoom back out. */
export const INPUT =
  "w-full bg-bg border border-control rounded-lg px-2.5 py-2.5 text-text text-base focus:outline-none focus:border-text";

/** Small buttons. Every one is at least 44px tall (min-h-11), the touch-target
 *  floor for a finger, however short its label; add min-w-11 for a button that
 *  is an icon alone. One shape in four styles, each with a pressed (active:)
 *  state. TEXT_BTN is an inline action that reads as a word ("edit", "Clear")
 *  and still gets the full-height target. */
const SMALL_BTN_SHAPE =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold cursor-pointer disabled:cursor-default disabled:opacity-50";
export const SMALL_BTN = `${SMALL_BTN_SHAPE} border border-border bg-transparent text-muted hover:bg-bg hover:text-text active:bg-border`;
/** A secondary action that should still stand out from SMALL_BTN. Neutral on
 *  purpose: the accent is for the one primary action on a screen. */
export const SMALL_BTN_STRONG = `${SMALL_BTN_SHAPE} border border-control bg-transparent text-text hover:bg-bg active:bg-border`;
export const SMALL_BTN_DANGER = `${SMALL_BTN_SHAPE} border border-danger/40 bg-transparent text-danger hover:bg-danger/10 active:bg-danger/20`;
export const SMALL_BTN_SOLID = `${SMALL_BTN_SHAPE} border-0 bg-accent text-on-accent hover:brightness-95 active:brightness-90`;
export const TEXT_BTN =
  "inline-flex min-h-11 items-center cursor-pointer border-0 bg-transparent px-1 text-[13px] text-muted hover:text-text active:text-text disabled:cursor-default disabled:opacity-50";

/** Status tones. Only warn and danger carry color; "ok" is a success state,
 *  shown in muted text with a check mark so it never reads as the accent,
 *  which belongs to the primary action alone. */
export type Tone = "ok" | "danger" | "warn" | "muted" | "faint";

const TONE: Record<Tone, string> = {
  ok: "border border-border text-muted",
  danger: "bg-danger-dim text-danger",
  warn: "bg-warn-dim text-warn",
  muted: "bg-border text-muted",
  faint: "border border-border text-faint",
};

const DOT: Record<Tone, string> = {
  ok: "bg-muted",
  danger: "bg-danger",
  warn: "bg-warn",
  muted: "bg-border",
  faint: "bg-border",
};

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`${CARD} ${className}`}>{children}</div>;
}

export function CardTitle({
  children,
  aside,
}: {
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 mb-3.5">
      <h3 className="text-[15px] font-semibold">{children}</h3>
      {aside ? <div className="ml-auto">{aside}</div> : null}
    </div>
  );
}

export function Chip({
  children,
  tone = "muted",
  size = "sm",
}: {
  children: ReactNode;
  tone?: Tone;
  size?: "sm" | "xs";
}) {
  return (
    <span
      className={`inline-block w-fit justify-self-start whitespace-nowrap rounded-full py-0.5 text-xs font-semibold ${size === "xs" ? "px-2" : "px-2.5"} ${TONE[tone]}`}
    >
      {tone === "ok" ? <span aria-hidden="true">{"\u2713 "}</span> : null}
      {children}
    </span>
  );
}

export function Dot({ tone = "muted" }: { tone?: Tone }) {
  return (
    <span
      className={`block w-2.5 h-2.5 shrink-0 rounded-full ${DOT[tone]}`}
    />
  );
}

export function StatCard({
  label,
  value,
  sub,
  tone = "muted",
  center = false,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: Tone;
  center?: boolean;
}) {
  const color =
    tone === "danger"
      ? "text-danger"
      : tone === "warn"
        ? "text-warn"
        : "text-text";
  return (
    <div className={`${CARD} ${center ? "text-center" : ""}`}>
      <div className="text-[13px] text-muted mb-1.5">
        {label}
      </div>
      <div
        className={`text-[26px] font-bold tracking-[-0.02em] ${color} ${NUM}`}
      >
        {value}
      </div>
      {sub ? <div className="text-xs text-faint mt-1">{sub}</div> : null}
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  full,
  href,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  full?: boolean;
  href?: string;
}) {
  const cls = `inline-block rounded-lg bg-accent px-6 py-3 text-[15px] font-semibold text-on-accent cursor-pointer border-0 hover:brightness-95 active:brightness-90 disabled:opacity-50 disabled:cursor-default ${full ? "w-full" : ""}`;
  if (href) {
    return (
      <a className={cls} href={href}>
        {children}
      </a>
    );
  }
  return (
    <button className={cls} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function FilterPill({
  children,
  active,
  onClick,
}: {
  children: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border px-3 text-xs cursor-pointer active:bg-bg ${active ? "border-text bg-transparent text-text font-semibold" : "border-border bg-transparent text-muted hover:text-text"}`}
    >
      {children}
    </button>
  );
}

/** Grid-based table. `cols` is a Tailwind grid-template class, e.g.
 *  "grid-cols-[2fr_1fr_1fr_130px]". */
export function TableHead({
  cols,
  children,
}: {
  cols: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`grid ${cols} gap-2 border-b border-border pb-2 text-xs font-medium text-muted`}
    >
      {children}
    </div>
  );
}

export function TableRow({
  cols,
  children,
  selected,
  onClick,
  align = "center",
}: {
  cols: string;
  children: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  align?: "center" | "start";
}) {
  return (
    <div
      onClick={onClick}
      className={`grid ${cols} gap-2 border-b border-border py-3 text-[13px] ${align === "center" ? "items-center" : "items-start"} ${selected ? "bg-bg" : ""} ${onClick ? "cursor-pointer hover:bg-bg" : ""}`}
    >
      {children}
    </div>
  );
}

export function Note({
  children,
  tone = "plain",
}: {
  children: ReactNode;
  tone?: "plain" | "emphasis";
}) {
  return (
    <div
      className={`rounded-lg p-3.5 text-[13px] leading-relaxed ${tone === "emphasis" ? "bg-surface border border-control text-text" : "bg-bg border border-border text-muted"}`}
    >
      {children}
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Right-side slide-over. Forms live here rather than in a modal so the page
 *  behind them stays readable while a customer fills one in.
 *
 *  A dialog for assistive tech and the keyboard: Escape and the close button
 *  both close it, focus moves into it on open and back to whatever opened it
 *  on close. Tab and Shift+Tab cycle inside the panel: it is aria-modal, so a
 *  screen reader treats the page behind as gone, and focus must not reach it. */
export function Drawer({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // The latest onClose, so the effect below runs once per open rather than on
  // every render of a parent that passes a new arrow each time.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close.current();
      if (e.key === "Tab") keepFocusInside(e);
    }
    function keepFocusInside(e: KeyboardEvent) {
      const root = panel.current;
      if (!root) return;
      const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0
      );
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const target = trappedFocusTarget(focusable, active, e.shiftKey);
      if (target === null && focusable.length > 0) return;
      e.preventDefault();
      (target ?? root).focus();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, []);

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="fixed top-0 right-0 bottom-0 w-[440px] max-w-[92vw] bg-surface border-l border-border p-6 overflow-y-auto z-50 focus:outline-none"
      >
        <div className="flex items-start gap-3 mb-6">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-xl font-bold mb-1 break-words">
              {title}
            </h2>
            <div className="text-muted text-sm break-words">{subtitle}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted hover:bg-bg hover:text-text active:bg-border"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 22 22"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M5 5l12 12" />
              <path d="M17 5L5 17" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

/** A grey block standing in for content that is still loading. Sized by the
 *  caller so the page does not jump when the real content arrives. */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`rounded-md bg-border/60 ${className}`} />
  );
}

/** Card-shaped placeholders for a list that is loading. */
export function SkeletonCards({
  count = 2,
  label = "Loading",
}: {
  count?: number;
  label?: string;
}) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={CARD}>
          <Skeleton className="h-4 w-1/3 mb-3" />
          <Skeleton className="h-3 w-2/3 mb-2" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/** A load that failed: what happened, in words, and a way to try again. */
export function ErrorState({
  message,
  onRetry,
  action,
}: {
  message: string;
  onRetry?: () => void;
  /** A link that fixes the problem, shown before Try again. */
  action?: { href: string; label: string };
}) {
  return (
    <div role="alert" className={`${CARD} flex flex-wrap items-center gap-3`}>
      {/* A basis, so the buttons wrap under a long message on a phone
          instead of squeezing it to one word per line. */}
      <p className="min-w-0 flex-1 basis-[16rem] text-sm text-text">{message}</p>
      {action ? (
        <a
          href={action.href}
          className="inline-flex min-h-11 items-center rounded-lg border border-control bg-transparent px-4 text-sm font-semibold text-text hover:bg-bg active:bg-border"
        >
          {action.label}
        </a>
      ) : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-11 cursor-pointer rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-bg active:bg-border"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
