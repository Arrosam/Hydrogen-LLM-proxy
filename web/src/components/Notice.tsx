import type { ReactNode } from "react";
import { Icon } from "./Button";

export type NoticeTone = "error" | "warning" | "success";

const TONE: Record<NoticeTone, { box: string; icon: string }> = {
  error: { box: "border-red-900/50 bg-red-950/30 text-red-300", icon: "bi-exclamation-octagon-fill" },
  warning: { box: "border-amber-900/50 bg-amber-950/30 text-amber-300", icon: "bi-exclamation-triangle-fill" },
  success: { box: "border-emerald-900/50 bg-emerald-950/30 text-emerald-300", icon: "bi-check-circle-fill" },
};

const PADDING = { md: "px-4 py-3", sm: "px-3 py-2" } as const;

/**
 * A bordered, tinted message box.
 *
 * - `size`: "md" is the page-level box (`ErrorNote`); "sm" the in-form one.
 * - `icon`: overrides the tone's default glyph; `false` draws none.
 * - `layout`: "flex" centres icon and text on a row; "inline" lets the text
 *   wrap around a leading icon (the proxy test result).
 */
export function Notice({
  tone,
  size = "md",
  icon,
  layout = "flex",
  className,
  children,
}: {
  tone: NoticeTone;
  size?: keyof typeof PADDING;
  icon?: string | false;
  layout?: "flex" | "inline";
  className?: string;
  children: ReactNode;
}) {
  const glyph = icon === false ? null : (icon ?? TONE[tone].icon);
  const inline = layout === "inline";
  return (
    <div
      className={`${inline ? "" : "flex items-center gap-2 "}rounded-lg border ${TONE[tone].box} ${PADDING[size]} text-sm${className ? ` ${className}` : ""}`}
    >
      {glyph && <Icon name={glyph} className={inline ? "mr-2" : undefined} />}
      {children}
    </div>
  );
}

const DASHED_PADDING = { sm: "px-3 py-2.5", lg: "px-4 py-6 text-center" } as const;

/** The dashed "nothing here yet" line: "sm" inside a form, "lg" as an empty editor list. */
export function DashedHint({ size = "sm", children }: { size?: keyof typeof DASHED_PADDING; children: ReactNode }) {
  return <p className={`rounded-lg border border-dashed border-ink-700 ${DASHED_PADDING[size]} text-xs text-ink-500`}>{children}</p>;
}
