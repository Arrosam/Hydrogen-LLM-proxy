import { useI18n } from "../lib/i18n";
import { ROLE } from "../auth";
import type { Role } from "../types";
import { Icon } from "./Button";

/**
 * Green when on; when off, red by default or gray (`offTone`) where "disabled"
 * is a neutral state rather than a problem. `labels` replaces the common
 * Enabled/Disabled wording.
 */
export function EnabledBadge({
  enabled,
  offTone = "red",
  labels,
}: {
  enabled: boolean;
  offTone?: "red" | "gray";
  labels?: { on: string; off: string };
}) {
  const { t } = useI18n();
  return (
    <span className={enabled ? "badge-green" : `badge-${offTone}`}>
      {enabled ? (labels?.on ?? t("common.enabled")) : (labels?.off ?? t("common.disabled"))}
    </span>
  );
}

/** A user's role: admins in blue with a shield, everyone else gray. */
export function RoleBadge({ role }: { role?: Role }) {
  const { t } = useI18n();
  const admin = role === ROLE.admin;
  return (
    <span className={admin ? "badge-blue" : "badge-gray"}>
      <Icon name={admin ? "bi-shield-lock" : "bi-person-gear"} />
      {role ? t(`users.role.${role}`) : null}
    </span>
  );
}

/** Stands where a row's actions would be for someone who may not use them. */
export function ReadOnlyNote() {
  const { t } = useI18n();
  return <span className="text-xs text-ink-500">{t("common.readOnly")}</span>;
}
