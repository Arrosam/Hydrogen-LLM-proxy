import { useState, type ChangeEvent } from "react";
import { api } from "../api";
import { useToast } from "../components/Toast";
import { useAction, useAttempt, type Action, type AttemptOptions } from "./hooks";

type StringKeys<F> = { [K in keyof F]-?: F[K] extends string ? K : never }[keyof F];
type TextControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export interface FormController<F> {
  /** The open form's values, or null while the modal is closed. */
  form: F | null;
  open: (initial: F) => void;
  close: () => void;
  set: <K extends keyof F>(key: K, value: F[K]) => void;
  /** Merge over whatever the form holds when the update runs (safe after an await). */
  patch: (partial: Partial<F>) => void;
  /** `value` + `onChange` for a text input, textarea or select editing a string field. */
  bind: <K extends StringKeys<F>>(key: K) => { value: F[K]; onChange: (e: ChangeEvent<TextControl>) => void };
}

type Bind<F> = FormController<F>["bind"];

/** The field accessors both form hooks hand out, over whichever state holds the values. */
function fieldAccessors<F extends object>(current: F | null, patch: (partial: Partial<F>) => void) {
  const set = <K extends keyof F>(key: K, value: F[K]): void => patch({ [key]: value } as unknown as Partial<F>);
  const bind: Bind<F> = (key) => ({
    value: (current as F)[key],
    onChange: (e) => set(key, e.target.value as F[typeof key]),
  });
  return { set, patch, bind };
}

/**
 * State of a create/edit modal: null = closed, an object = open with those
 * values. Replaces the `useState<F | null>` + `setForm({ ...form, k: v })`
 * pattern of every CRUD page.
 */
export function useFormState<F extends object>(): FormController<F> {
  const [form, setForm] = useState<F | null>(null);
  const patch = (partial: Partial<F>): void => setForm((f) => (f ? { ...f, ...partial } : f));
  return { form, open: setForm, close: () => setForm(null), ...fieldAccessors(form, patch) };
}

export interface FieldsController<F> extends Pick<FormController<F>, "set" | "patch" | "bind"> {
  values: F;
}

/**
 * The always-present form of `useFormState`: one object for a form that
 * exists for as long as its component does (an editor mounted per record, a
 * settings card), instead of one `useState` per field.
 */
export function useFields<F extends object>(initial: F | (() => F)): FieldsController<F> {
  const [values, setValues] = useState<F>(initial);
  const patch = (partial: Partial<F>): void => setValues((v) => ({ ...v, ...partial }));
  return { values, ...fieldAccessors(values, patch) };
}

export interface SaveOptions<F, R> {
  /** POST target for a new record. */
  collection: string;
  /** PATCH target for an existing one (a form whose `id` is set). */
  member?: (id: number) => string;
  /** The request body, or null when the form does not add up (report why before returning null). */
  toPayload: (form: F) => unknown | null;
  /** Toast texts for this save; `success` omitted = no success toast. */
  messages: (editing: boolean) => { success?: string; failed: string };
  /** After the modal has closed: usually `reload`. */
  onSaved: (response: R, form: F) => void;
  /** Share a busy flag with another action instead of owning one. */
  action?: Action;
}

/**
 * The save half of a CRUD modal: build the payload, PATCH when the form has
 * an id and POST when it does not, toast, close, hand over to `onSaved`.
 */
export function useSave<F extends { id?: number }, R = unknown>(
  fc: FormController<F>,
  opts: SaveOptions<F, R>,
): { save: () => Promise<void>; saving: boolean } {
  const toast = useToast();
  const own = useAction();
  const action = opts.action ?? own;
  const save = async (): Promise<void> => {
    const form = fc.form;
    if (!form) return;
    const payload = opts.toPayload(form);
    if (payload === null) return;
    const editing = Boolean(form.id);
    const messages = opts.messages(editing);
    await action.run(async () => {
      const response =
        form.id && opts.member ? await api.patch<R>(opts.member(form.id), payload) : await api.post<R>(opts.collection, payload);
      if (messages.success) toast.success(messages.success);
      fc.close();
      opts.onSaved(response, form);
    }, messages.failed);
  };
  return { save, saving: action.busy };
}

export interface DeleteRequest {
  /** Confirm dialog title and body. */
  title: string;
  body: string;
  /** DELETE target. */
  path: string;
  /** Success toast; omitted = none. */
  success?: string;
  /** Error toast when the failure carries no server message. */
  fallback?: string;
}

/**
 * Confirm, DELETE, toast, reload. `confirm` is the page's own `useConfirm()`
 * function (the page still renders its `confirmEl`).
 */
export function useDeleteAction(
  confirm: (title: string, message: string) => Promise<boolean>,
  onDeleted: () => void,
  opts: AttemptOptions = {},
): (request: DeleteRequest) => Promise<void> {
  const toast = useToast();
  const attempt = useAttempt(opts);
  return async ({ title, body, path, success, fallback }) => {
    if (!(await confirm(title, body))) return;
    await attempt(async () => {
      await api.del(path);
      if (success) toast.success(success);
      onDeleted();
    }, fallback);
  };
}
