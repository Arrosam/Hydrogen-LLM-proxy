import type { ReactNode } from "react";

interface ModalProps {
  open: boolean;
  title: string;
  icon?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Extra controls rendered in the title bar, before the close button. */
  headerExtra?: ReactNode;
  wide?: boolean;
}

export function Modal({ open, title, icon, onClose, children, footer, headerExtra, wide }: ModalProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div
        className={`card flex max-h-[92vh] w-full flex-col ${wide ? "max-w-4xl" : "max-w-lg"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-ink-800 px-5 py-3.5">
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink-100">
            {icon && <i className={`bi ${icon} text-brand-400`} />}
            {title}
          </h2>
          <div className="flex items-center gap-3">
            {headerExtra}
            <button className="text-ink-500 hover:text-ink-200" onClick={onClose}>
              <i className="bi bi-x-lg" />
            </button>
          </div>
        </div>
        <div className="card-pad min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && (
          <div className="flex shrink-0 justify-end gap-2 border-t border-ink-800 px-5 py-3.5">{footer}</div>
        )}
      </div>
    </div>
  );
}
