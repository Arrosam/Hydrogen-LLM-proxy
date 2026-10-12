import { useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { Button, Icon } from "./Button";
import { Notice } from "./Notice";
import { useI18n } from "../lib/i18n";
import { ACTION_ICON } from "../lib/icons";
import { HTTP_CLIENT_CLOSED, isSuccessStatus } from "../lib/http";

/**
 * The loading indicator. Default: a block in the flow of a page, with an
 * optional caption. `fullScreen`: alone in the middle of the viewport, larger
 * and in the brand colour (the app's first paint, before the session is known).
 * `card`: the block is itself a card, a little shorter (a result that is still
 * on its way, between other cards).
 */
export function Spinner({ label, fullScreen, card }: { label?: string; fullScreen?: boolean; card?: boolean }) {
  const frame = fullScreen ? "h-screen text-brand-400" : `gap-2 ${card ? "py-12" : "py-16"} text-ink-400`;
  return (
    <div className={`${card ? "card card-pad " : ""}flex items-center justify-center ${frame}`}>
      <Icon name={ACTION_ICON.busy} className={fullScreen ? "text-3xl" : "text-xl"} />
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
  const cls = isSuccessStatus(status) ? "badge-green" : status === HTTP_CLIENT_CLOSED ? "badge-gray" : "badge-red";
  return <span className={cls}>{label ?? (status || t("common.statusError"))}</span>;
}

export function ErrorNote({ message }: { message: string }) {
  return <Notice tone="error">{message}</Notice>;
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
          <Button variant="ghost" onClick={() => close(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" icon={ACTION_ICON.remove} onClick={() => close(true)}>
            {t("common.confirm")}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-300">{state.message}</p>
    </Modal>
  );

  return { confirm, confirmEl };
}
