import type { ReactNode } from "react";
import { ACTION_ICON } from "../lib/icons";
import { useI18n } from "../lib/i18n";
import { Button } from "./Button";
import { Modal, type ModalSize } from "./Modal";

export interface FormModalProps {
  open: boolean;
  title: string;
  icon?: string;
  size?: ModalSize;
  onClose: () => void;
  onSubmit: () => void;
  /** Caption of the primary button. */
  submitLabel: string;
  submitIcon?: string;
  /** Default: the common "Cancel". */
  cancelLabel?: string;
  /** The save is running: the primary button is disabled. */
  busy?: boolean;
  /** Also spin the primary button's icon while busy. */
  spinWhenBusy?: boolean;
  /** Any further reason the form cannot be submitted yet. */
  disabled?: boolean;
  /**
   * Controls at the left of the footer (a "test connection" button). With it
   * the footer becomes a full-width row: these on the left, Cancel + submit
   * grouped on the right.
   */
  footerStart?: ReactNode;
  /**
   * Secondary actions at the left that stay direct children of the footer,
   * pushed apart from Cancel + submit by a spacer (the service editor's
   * view / validate / dry-run buttons).
   */
  footerLead?: ReactNode;
  children: ReactNode;
}

/** A `Modal` with the standard form footer: ghost Cancel, primary submit. */
export function FormModal({
  open,
  title,
  icon,
  size,
  onClose,
  onSubmit,
  submitLabel,
  submitIcon = ACTION_ICON.save,
  cancelLabel,
  busy,
  spinWhenBusy,
  disabled,
  footerStart,
  footerLead,
  children,
}: FormModalProps) {
  const { t } = useI18n();
  const buttons = (
    <>
      <Button variant="ghost" onClick={onClose}>
        {cancelLabel ?? t("common.cancel")}
      </Button>
      <Button variant="primary" icon={submitIcon} busy={busy} spinWhenBusy={spinWhenBusy} disabled={disabled} onClick={onSubmit}>
        {submitLabel}
      </Button>
    </>
  );
  return (
    <Modal
      open={open}
      title={title}
      icon={icon}
      size={size}
      onClose={onClose}
      footer={
        footerLead ? (
          <>
            {footerLead}
            <div className="flex-1" />
            {buttons}
          </>
        ) : footerStart ? (
          <div className="flex w-full items-center justify-between gap-2">
            {footerStart}
            <div className="flex gap-2">{buttons}</div>
          </div>
        ) : (
          buttons
        )
      }
    >
      {children}
    </Modal>
  );
}
