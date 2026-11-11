// Imported only by client components; Drawer uses hooks, so a server
// component must not render it directly.
import { useEffect, useId, useRef, type ReactNode } from "react";

/** The repeated utility strings, in one place. No transitions: hover is
 *  colour-only, per the design system. */

export const CARD = "bg-surface border border-border rounded-xl p-6";
export const NUM = "[font-variant-numeric:tabular-nums]";
export const MONO = "font-mono";
export const H1 = "text-[26px] font-bold tracking-[-0.02em] mb-1.5";
export const LEAD = "text-muted mb-7 max-w-[640px]";
export const LABEL = "block text-[13px] font-semibold text-muted mb-1.5";
export const INPUT =
  "w-full bg-bg border border-border rounded-lg px-2.5 py-2.5 text-text text-sm focus:outline-none focus:border-accent";

export type Tone =
  | "accent"
  | "danger"
  | "warn"
  | "info"
  | "muted"
  | "faint";

const TONE: Record<Tone, string> = {
  accent: "bg-accent-dim text-accent",
  danger: "bg-danger/20 text-danger",
  warn: "bg-warn/20 text-warn",
  info: "bg-info/20 text-info",
  muted: "bg-border text-muted",
  faint: "bg-border text-faint",
};

const DOT: Record<Tone, string> = {
  accent: "bg-accent",
  danger: "bg-danger",
  warn: "bg-warn",
  info: "bg-info",
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
      className={`inline-block w-fit justify-self-start whitespace-nowrap rounded-full px-2.5 py-0.5 font-semibold ${size === "xs" ? "text-[11px]" : "text-xs"} ${TONE[tone]}`}
    >
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
  tone = "accent",
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
        : tone === "muted"
          ? "text-text"
          : "text-accent";
  return (
    <div className={`${CARD} ${center ? "text-center" : ""}`}>
      <div className="text-[11px] uppercase tracking-[0.06em] text-muted mb-1.5">
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
  const cls = `inline-block rounded-lg bg-accent px-6 py-3 text-[15px] font-semibold text-bg cursor-pointer border-0 hover:bg-accent/90 disabled:opacity-50 disabled:cursor-default ${full ? "w-full" : ""}`;
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
      className={`rounded-full border px-3 py-1 text-xs cursor-pointer ${active ? "border-accent bg-accent-dim text-accent" : "border-border bg-transparent text-muted hover:text-text"}`}
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
      className={`grid ${cols} gap-2 border-b border-border pb-2 text-[11px] uppercase tracking-[0.06em] text-faint`}
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
  tone?: "plain" | "accent";
}) {
  return (
    <div
      className={`rounded-lg p-3.5 text-[13px] leading-relaxed ${tone === "accent" ? "bg-accent-dim/40 border border-accent/15 text-text" : "bg-bg border border-border text-muted"}`}
    >
      {children}
    </div>
  );
}

/** Right-side slide-over. Forms live here rather than in a modal so the page
 *  behind them stays readable while a customer fills one in.
 *
 *  A dialog for assistive tech and the keyboard: Escape and the close button
 *  both close it, focus moves into it on open and back to whatever opened it
 *  on close. Focus is not trapped; the overlay already blocks the page. */
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
            className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted hover:bg-bg hover:text-text"
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
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className={`${CARD} flex flex-wrap items-center gap-3`}>
      <p className="min-w-0 flex-1 text-sm text-text">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-11 cursor-pointer rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-bg"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
