/**
 * The Hydrogen brand mark: hydrogen's emission-line spectrum in a badge — the
 * fingerprint the element is identified by. Inline SVG (no asset request);
 * colors are fixed brand values, independent of the surrounding theme.
 * Keep in sync with web/public/favicon.svg, which carries the same artwork.
 */
export function HydrogenLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label="Hydrogen">
      <g transform="translate(32 32) scale(1.295) translate(-32 -32)">
        <rect x="10" y="14" width="44" height="36" rx="8" fill="#0c1219" stroke="#273140" strokeWidth="1.5" />
        <line x1="14.5" y1="21" x2="14.5" y2="43" stroke="#22d3ee" strokeWidth="1.5" strokeLinecap="round" strokeOpacity=".2" />
        <line x1="17" y1="21" x2="17" y2="43" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" strokeOpacity=".3" />
        <line x1="22.5" y1="21" x2="22.5" y2="43" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" strokeOpacity=".5" />
        <line x1="30" y1="21" x2="30" y2="43" stroke="#22d3ee" strokeWidth="2.5" strokeLinecap="round" strokeOpacity=".8" />
        <line x1="42" y1="21" x2="42" y2="43" stroke="#5eead4" strokeWidth="7" strokeLinecap="round" strokeOpacity=".18" />
        <line x1="42" y1="21" x2="42" y2="43" stroke="#5eead4" strokeWidth="3.5" strokeLinecap="round" />
      </g>
    </svg>
  );
}
