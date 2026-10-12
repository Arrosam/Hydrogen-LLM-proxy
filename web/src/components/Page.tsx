import type { ReactNode } from "react";
import type { AsyncState } from "../lib/hooks";
import { ErrorNote, Spinner } from "./common";

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  icon?: string;
  /** Right-aligned control(s), usually the page's "new" button. */
  action?: ReactNode;
}

export function PageHeader({ title, subtitle, icon, action }: PageHeaderProps) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold text-ink-100">
          {icon && <i className={`bi ${icon} text-brand-400`} />}
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-ink-400">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

type LoadState<T> = Pick<AsyncState<T>, "data" | "loading" | "error">;

/**
 * The spinner and error line of an async load. Both sit ABOVE whatever is
 * already rendered: during a reload `loading` is true while `data` is still
 * set, and the stale content stays on screen under the spinner.
 */
export function AsyncStatus<T>({ state, loadingLabel }: { state: LoadState<T>; loadingLabel?: string }) {
  return (
    <>
      {state.loading && <Spinner label={loadingLabel} />}
      {state.error && <ErrorNote message={state.error} />}
    </>
  );
}

export interface ResourcePageProps<T> extends PageHeaderProps {
  state: LoadState<T>;
  loadingLabel?: string;
  /**
   * True (default): the header is always there and the spinner / error sit
   * under it. False: while loading, or after a failed load, the page is ONLY
   * the spinner or the error -- no header, no content. No page asks for
   * this any more: a page without its header while loading was the odd one out.
   */
  headerWhileLoading?: boolean;
  /**
   * Hold the body back until the first load has answered: for a page whose
   * body is a form over the loaded data (the bench) rather than a list that
   * guards on its own rows. Until then, and after a failed first load, the
   * page is its header and the spinner or error.
   */
  bodyWhenLoaded?: boolean;
  /** With `empty`: shows it once data has arrived and this says there is nothing. */
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  /** Classes of the page's root element ("space-y-4" on the bench, whose blocks space themselves). */
  className?: string;
  /** The page body: lists, modals, the confirm dialog. Rendered regardless of
   * load state (guard on the data yourself, or pass `bodyWhenLoaded`), after the empty state. */
  children?: ReactNode;
}

/** Header + load status + empty state + body: the frame of a list page. */
export function ResourcePage<T>({
  state,
  loadingLabel,
  headerWhileLoading = true,
  bodyWhenLoaded = false,
  isEmpty,
  empty,
  className,
  children,
  ...header
}: ResourcePageProps<T>) {
  if (!headerWhileLoading) {
    if (state.loading) return <Spinner label={loadingLabel} />;
    if (state.error) return <ErrorNote message={state.error} />;
  }
  return (
    <div className={className}>
      <PageHeader {...header} />
      {headerWhileLoading && <AsyncStatus state={state} loadingLabel={loadingLabel} />}
      {state.data && isEmpty?.(state.data) && empty}
      {(!bodyWhenLoaded || state.data) && children}
    </div>
  );
}
