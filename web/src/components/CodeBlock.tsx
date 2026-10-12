import type { ReactNode } from "react";

/** Scroll caps in use. Each is a height some block has today; none is derived from another. */
const MAX_HEIGHT = {
  sm: "max-h-64",
  md: "max-h-72",
  lg: "max-h-80",
  xl: "max-h-96",
  screen: "max-h-[60vh]",
} as const;

/** The box around the text: the usual dark one, the red one of an upstream error, or none. */
const FRAME = {
  box: "rounded-lg border border-ink-800 bg-ink-950",
  error: "rounded-lg border border-red-900/50 bg-red-950/30",
  none: "",
} as const;

/** Inner spacing: "md" a standalone block, "sm" one nested in a detail row, "row" an unframed block inside a card. */
const PADDING = { md: "p-3", sm: "p-2", row: "px-3 py-2" } as const;

const TONE = {
  strong: "text-ink-200",
  normal: "text-ink-300",
  muted: "text-ink-400",
  error: "text-red-300",
} as const;

export interface CodeBlockProps {
  /** `pre` (default) for payloads and output; `p` for a one-paragraph message. */
  as?: "pre" | "p";
  /** Caps the height and makes the block scroll. Omitted: it grows with its text. */
  maxHeight?: keyof typeof MAX_HEIGHT;
  frame?: keyof typeof FRAME;
  padding?: keyof typeof PADDING;
  tone?: keyof typeof TONE;
  /** Looser line spacing, for long JSON. */
  relaxed?: boolean;
  /** Outer spacing ("mt-1", "mt-2"). */
  className?: string;
  children: ReactNode;
}

/** Monospace, wrapping, preformatted text: payloads, error bodies, model output. */
export function CodeBlock({
  as: Tag = "pre",
  maxHeight,
  frame = "box",
  padding = "md",
  tone = "normal",
  relaxed = false,
  className,
  children,
}: CodeBlockProps) {
  const classes = [
    className,
    maxHeight && `${MAX_HEIGHT[maxHeight]} overflow-auto`,
    "whitespace-pre-wrap break-words",
    FRAME[frame],
    PADDING[padding],
    "font-mono text-xs",
    relaxed && "leading-relaxed",
    TONE[tone],
  ];
  return <Tag className={classes.filter(Boolean).join(" ")}>{children}</Tag>;
}

/** The quiet "nothing recorded" box that stands in for a block with no content. */
export function MutedBox({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`${className ? `${className} ` : ""}rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 text-xs text-ink-500`}>
      {children}
    </div>
  );
}
