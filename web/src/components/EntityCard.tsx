import type { ReactNode } from "react";
import { ACTION_ICON } from "../lib/icons";
import { Button, Icon } from "./Button";

export interface RowActionsProps {
  /** Layout classes of the group beyond `flex gap-1.5` ("justify-end" in a
   * table cell, "shrink-0" beside a card title, "mt-3 justify-end" under one). */
  className?: string;
  /** Controls before the edit button. */
  lead?: ReactNode;
  /** Omit to draw no edit button. */
  onEdit?: () => void;
  /** Caption beside the pencil; omitted = icon only. */
  editLabel?: string;
  /** Omit to draw no delete button. */
  onDelete?: () => void;
  /** Delete glyph: the usual `bi-trash3`, or a site's own. */
  deleteIcon?: string;
  /** Caption beside the delete glyph; omitted = icon only. */
  deleteLabel?: string;
  deleteDisabled?: boolean;
  /** Anything after the delete button (a read-only note). */
  children?: ReactNode;
}

/** The edit + delete pair at the end of a table row or on an entity card. */
export function RowActions({
  className,
  lead,
  onEdit,
  editLabel,
  onDelete,
  deleteIcon = ACTION_ICON.remove,
  deleteLabel,
  deleteDisabled,
  children,
}: RowActionsProps) {
  return (
    <div className={`flex${className ? ` ${className}` : ""} gap-1.5`}>
      {lead}
      {onEdit && (
        <Button variant="ghost" size="xs" icon={ACTION_ICON.edit} onClick={onEdit}>
          {editLabel}
        </Button>
      )}
      {onDelete && (
        <Button variant="danger" size="xs" icon={deleteIcon} disabled={deleteDisabled} onClick={onDelete}>
          {deleteLabel}
        </Button>
      )}
      {children}
    </div>
  );
}

const TITLE_STYLE = {
  plain: "font-medium text-ink-100",
  mono: "truncate font-mono text-sm font-semibold text-ink-100",
} as const;

const DESCRIPTION_STYLE = {
  sm: "mt-0.5 text-sm text-ink-400",
  xs: "mt-1 text-xs text-ink-400",
} as const;

export interface EntityCardProps {
  /** Entity glyph before the name. */
  icon?: string;
  title: string;
  /** "mono" for an identifier clients type (a service name). */
  titleStyle?: keyof typeof TITLE_STYLE;
  /** Badges after the name. */
  badges?: ReactNode;
  description?: string | null;
  descriptionSize?: keyof typeof DESCRIPTION_STYLE;
  /** Further lines under the name, inside the text column. */
  details?: ReactNode;
  /** Top-right of the card: its actions, or a count badge. */
  aside?: ReactNode;
  /** Let the text column shrink so a long name truncates instead of pushing `aside` out. */
  shrinkText?: boolean;
  /** Keep a gap between the text column and `aside`. */
  gap?: boolean;
  /** Below the header row: sections, summaries, bottom-placed actions. */
  children?: ReactNode;
}

/** One entity in a card list: name row, description, an aside, then free content. */
export function EntityCard({
  icon,
  title,
  titleStyle = "plain",
  badges,
  description,
  descriptionSize = "sm",
  details,
  aside,
  shrinkText,
  gap,
  children,
}: EntityCardProps) {
  return (
    <div className="card card-pad">
      <div className={`flex items-start justify-between${gap ? " gap-3" : ""}`}>
        <div className={shrinkText ? "min-w-0" : undefined}>
          <div className="flex items-center gap-2">
            {icon && <Icon name={icon} className="text-brand-400" />}
            <span className={TITLE_STYLE[titleStyle]}>{title}</span>
            {badges}
          </div>
          {description && <p className={DESCRIPTION_STYLE[descriptionSize]}>{description}</p>}
          {details}
        </div>
        {aside}
      </div>
      {children}
    </div>
  );
}
