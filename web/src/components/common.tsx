import { useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { useI18n } from "../lib/i18n";

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
