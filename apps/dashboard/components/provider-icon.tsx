// A connection type's mark, drawn inline from lib/provider-icons.ts. It is
// decorative: always put the provider's name next to it as text, which is
// what a screen reader reads.
//
// Fill and stroke are currentColor, so the mark is the color of the text
// around it (ink in light mode, bone in dark) and never needs its own token.

import { DRAWN_FRAME, DRAWN_STROKE, PROVIDER_ICONS, type ProviderIconData } from "../lib/provider-icons";

/** The data for a provider, or null for one the table does not know (an
 *  older API, a type added on the server first). */
export function providerIconData(provider: string): ProviderIconData | null {
  return Object.hasOwn(PROVIDER_ICONS, provider)
    ? PROVIDER_ICONS[provider as keyof typeof PROVIDER_ICONS]
    : null;
}

function Frame() {
  const { x, y, size, radius } = DRAWN_FRAME;
  return <rect x={x} y={y} width={size} height={size} rx={radius} />;
}

/**
 * `<ProviderIcon provider="aws" />`. `size` is in CSS pixels; every mark has
 * the same 24x24 viewBox, so marks at one size look one size. An unknown
 * provider gets the empty rounded square, so a row keeps its alignment.
 */
export function ProviderIcon({
  provider,
  size = 20,
  className = "",
}: {
  provider: string;
  size?: number;
  className?: string;
}) {
  const icon = providerIconData(provider);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      data-provider-icon={icon ? provider : "unknown"}
      className={`shrink-0 ${className}`.trim()}
    >
      {icon?.source === "simple-icons" ? (
        <path fill="currentColor" d={icon.path} />
      ) : (
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth={DRAWN_STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <Frame />
          {icon?.source === "drawn" && (
            <g strokeWidth={icon.letterStroke ?? DRAWN_STROKE}>
              {icon.strokes.map((d) => (
                <path key={d} d={d} />
              ))}
            </g>
          )}
        </g>
      )}
    </svg>
  );
}
