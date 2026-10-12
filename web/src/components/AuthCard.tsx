import type { FormEvent, ReactNode } from "react";
import { Notice } from "./Notice";

const WIDTH = { sm: "max-w-sm", lg: "max-w-2xl" } as const;

/**
 * The centred screen of the signed-out pages: a mark, a title, a line under
 * it, then a card holding the form. `error` is shown inside the form, above
 * `actions` (the submit button and anything after it).
 */
export function AuthCard({
  mark,
  title,
  subtitle,
  width = "sm",
  onSubmit,
  error,
  actions,
  children,
}: {
  mark: ReactNode;
  title: string;
  subtitle: ReactNode;
  width?: keyof typeof WIDTH;
  onSubmit: (e: FormEvent) => void;
  error?: string | null;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className={`w-full ${WIDTH[width]}`}>
        <div className="mb-8 flex flex-col items-center gap-3">
          {mark}
          <div className="text-center">
            <h1 className="text-xl font-semibold text-ink-100">{title}</h1>
            <p className="text-sm text-ink-500">{subtitle}</p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="card card-pad space-y-4">
          {children}
          {error && (
            <Notice tone="error" size="sm" icon="bi-exclamation-circle">
              {error}
            </Notice>
          )}
          {actions}
        </form>
      </div>
    </div>
  );
}
