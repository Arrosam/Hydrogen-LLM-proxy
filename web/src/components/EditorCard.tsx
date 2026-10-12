import type { HTMLAttributes, ReactNode } from "react";
import { ACTION_ICON } from "../lib/icons";
import { Button, Icon } from "./Button";

type DivProps = HTMLAttributes<HTMLDivElement>;

const withClass = (base: string, className: string | undefined): string => (className ? `${className} ${base}` : base);

/** The frame of one item of an editor: a step, a stage, a pre-pass. */
export function EditorPanel({ className, ...rest }: DivProps) {
  return <div className={withClass("rounded-xl border border-ink-700 bg-ink-850/70 p-3", className)} {...rest} />;
}

/** A recessed box inside an editor panel: advanced settings, the overrides, a tester. */
export function InsetPanel({ className, ...rest }: DivProps) {
  return <div className={withClass("rounded-lg border border-ink-800 bg-ink-950/40 p-3", className)} {...rest} />;
}

/** One row of a list inside an editor panel: a context block, a transition. */
export function RowPanel({ className, ...rest }: DivProps) {
  return <div className={withClass("rounded-lg border border-ink-800 bg-ink-900/60 p-2 text-xs", className)} {...rest} />;
}

const HEADER_GAP = { md: "mb-2", sm: "mb-1.5", xs: "mb-1" } as const;

/**
 * Caption on the left, the list's control (usually "add") on the right.
 *
 * - `as`: the caption is a <span> over a list of cards and a <label> over a
 *   list of rows or a single control.
 * - `hint`: a lower-case note after the caption, separated by a space.
 */
export function ListHeader({
  label,
  hint,
  as: Caption = "span",
  gap = "md",
  action,
}: {
  label: ReactNode;
  hint?: ReactNode;
  as?: "span" | "label";
  gap?: keyof typeof HEADER_GAP;
  action?: ReactNode;
}) {
  return (
    <div className={`${HEADER_GAP[gap]} flex items-center justify-between`}>
      <Caption className="label mb-0">
        {label}
        {hint !== undefined && " "}
        {hint !== undefined && <span className="normal-case text-ink-500">{hint}</span>}
      </Caption>
      {action}
    </div>
  );
}

/** The ghost "+ add" button of a list header. */
export function AddButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="ghost" size="xs" icon={ACTION_ICON.add} onClick={onClick}>
      {children}
    </Button>
  );
}

export interface EditorCardProps {
  /** Text of the position badge ("Step 2"). */
  badge: string;
  /** Controls between the badge and the buttons (a stage's name). */
  headerExtra?: ReactNode;
  dragTitle: string;
  duplicateTitle: string;
  onDuplicate: () => void;
  onRemove: () => void;
  /** From `useReorderableList`. */
  dragHandleProps: HTMLAttributes<HTMLSpanElement>;
  dropTargetProps: DivProps;
  children: ReactNode;
}

/** One card of a reorderable editor list: grip, badge, duplicate, delete, then the item's own form. */
export function EditorCard({
  badge,
  headerExtra,
  dragTitle,
  duplicateTitle,
  onDuplicate,
  onRemove,
  dragHandleProps,
  dropTargetProps,
  children,
}: EditorCardProps) {
  return (
    <EditorPanel {...dropTargetProps}>
      <div className="mb-2.5 flex items-center gap-2">
        <span {...dragHandleProps} title={dragTitle} className="cursor-grab text-ink-600 hover:text-ink-300">
          <Icon name="bi-grip-vertical" />
        </span>
        <span className="badge-blue">{badge}</span>
        {headerExtra}
        <div className="flex-1" />
        <Button variant="ghost" size="xs" title={duplicateTitle} icon={ACTION_ICON.duplicate} onClick={onDuplicate} />
        <Button variant="danger" size="xs" icon={ACTION_ICON.remove} onClick={onRemove} />
      </div>
      {children}
    </EditorPanel>
  );
}
