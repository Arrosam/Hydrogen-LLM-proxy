import { useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { useI18n } from "../lib/i18n";
import type { Tool } from "../types";

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-ink-400">
      <i className="bi bi-arrow-repeat animate-spin text-xl" />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: string;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <i className={`bi ${icon} text-4xl text-ink-600`} />
      <div className="text-sm font-medium text-ink-300">{title}</div>
      {hint && <div className="max-w-sm text-xs text-ink-500">{hint}</div>}
      {action}
    </div>
  );
}

/** HTTP-status badge: 2xx green, 499 (client abort) gray, everything else red. */
export function StatusBadge({ status, label }: { status: number; label?: string }) {
  const { t } = useI18n();
  const cls =
    status >= 200 && status < 300 ? "badge-green" : status === 499 ? "badge-gray" : "badge-red";
  return <span className={cls}>{label ?? (status || t("common.statusError"))}</span>;
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">
      <i className="bi bi-exclamation-octagon-fill" />
      {message}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`inline-flex select-none items-center gap-2 ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-brand-600" : "bg-ink-700"} ${disabled ? "cursor-not-allowed" : ""}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[18px]" : "translate-x-[2px]"}`}
        />
      </button>
      {label && <span className="text-sm text-ink-300">{label}</span>}
    </label>
  );
}

interface ConfirmState {
  open: boolean;
  title: string;
  message: string;
  resolve?: (v: boolean) => void;
}

/** Returns a styled confirm() plus the element to render once in the page. */
export function useConfirm(): {
  confirm: (title: string, message: string) => Promise<boolean>;
  confirmEl: ReactNode;
} {
  const { t } = useI18n();
  const [state, setState] = useState<ConfirmState>({ open: false, title: "", message: "" });

  const confirm = (title: string, message: string) =>
    new Promise<boolean>((resolve) => setState({ open: true, title, message, resolve }));

  const close = (v: boolean) => {
    state.resolve?.(v);
    setState((s) => ({ ...s, open: false }));
  };

  const confirmEl = (
    <Modal
      open={state.open}
      title={state.title}
      icon="bi-exclamation-triangle-fill"
      onClose={() => close(false)}
      footer={
        <>
          <button className="btn-ghost" onClick={() => close(false)}>
            {t("common.cancel")}
          </button>
          <button className="btn-danger" onClick={() => close(true)}>
            <i className="bi bi-trash3" />
            {t("common.confirm")}
          </button>
        </>
      }
    >
      <p className="text-sm text-ink-300">{state.message}</p>
    </Modal>
  );

  return { confirm, confirmEl };
}

/**
 * Pick which free-form tools a service, agent or stage grants.
 *
 * A grant reaches a client that declared no tools at all, so only a FREE-FORM
 * tool can be granted -- a vocabulary one exists to answer a client that asked
 * for that hosted type by name, and granting it would reach nobody.
 *
 * A DISABLED tool is still listed, because a grant on one is valid and simply
 * inert until it is re-enabled; hiding it would make an existing grant look
 * like it had vanished. A name in `value` that matches no free-form tool at all
 * is shown in red rather than dropped -- that is how an operator sees a grant
 * left dangling, and the only place they can clear it.
 */
export function ToolGrantPicker({
  label,
  hint,
  tools,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  /** Every configured tool; the picker filters to the grantable ones itself.
   * Typed as `Tool` rather than structurally, so the `kind` union is checked --
   * the freeform filter below is the single line deciding what is grantable at
   * all, and a widened `string` would let a typo silently list nothing. */
  tools: Tool[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useI18n();
  const grantable = tools.filter((tool) => tool.kind === "freeform");
  const dangling = value.filter((name) => !grantable.some((tool) => tool.name === name));
  const toggle = (name: string) =>
    onChange(value.includes(name) ? value.filter((n) => n !== name) : [...value, name]);

  return (
    <div>
      <label className="label">{label}</label>
      {grantable.length === 0 && dangling.length === 0 ? (
        <p className="text-xs text-ink-500">{t("tools.grant.none")}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {grantable.map((tool) => {
            const on = value.includes(tool.name);
            return (
              <button
                key={tool.id}
                type="button"
                className={`${on ? "badge-blue" : "badge-gray"}${tool.enabled ? "" : " opacity-60"}`}
                title={tool.enabled ? undefined : t("tools.grant.disabled")}
                onClick={() => toggle(tool.name)}
              >
                <i className={`bi ${on ? "bi-check-lg" : "bi-plus-lg"}`} />
                {tool.name}
                {!tool.enabled && <i className="bi bi-slash-circle" />}
              </button>
            );
          })}
          {dangling.map((name) => (
            <button
              key={`missing:${name}`}
              type="button"
              className="badge-red"
              title={t("tools.grant.missing")}
              onClick={() => toggle(name)}
            >
              <i className="bi bi-exclamation-triangle" />
              {name}
            </button>
          ))}
        </div>
      )}
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}
