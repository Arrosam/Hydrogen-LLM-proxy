const TRACK_HEIGHT = { sm: "h-1.5", md: "h-2" } as const;

/**
 * A horizontal proportion bar: a rounded track with a fill `percent` wide.
 *
 * - `size`: "sm" is the slim bar of a ranking row, "md" a quota meter.
 * - `tone`: the fill's background class ("bg-brand-600").
 * - `animated`: the fill glides to a new width instead of jumping (a meter
 *   that is redrawn while the user watches).
 */
export function Bar({
  percent,
  tone,
  size = "sm",
  animated = false,
}: {
  percent: number;
  tone: string;
  size?: keyof typeof TRACK_HEIGHT;
  animated?: boolean;
}) {
  return (
    <div className={`${TRACK_HEIGHT[size]} overflow-hidden rounded-full bg-ink-800`}>
      <div className={`h-full rounded-full ${animated ? "transition-all duration-500 " : ""}${tone}`} style={{ width: `${percent}%` }} />
    </div>
  );
}
