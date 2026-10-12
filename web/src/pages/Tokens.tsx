import { msToLocalInput, editedExpiry } from "../lib/tokenForm";
import { useState } from "react";
import { api } from "../api";
import { useIsAdmin } from "../auth";
import { useAsync, useAttempt, useCopy } from "../lib/hooks";
import { nameById, setMember } from "../lib/collections";
import { useDeleteAction, useFormState, useSave } from "../lib/crud";
import { API } from "../lib/endpoints";
import { ACTION_ICON, ENTITY_ICON } from "../lib/icons";
import { useI18n } from "../lib/i18n";
import { fetchServices, fetchTokens, loadAll } from "../lib/resources";
import { EnabledBadge, ReadOnlyNote } from "../components/badges";
import { Button, Icon } from "../components/Button";
import { EmptyState, Toggle, useConfirm } from "../components/common";
import { DataTable, type Column } from "../components/DataTable";
import { RowActions } from "../components/EntityCard";
import { Field } from "../components/Field";
import { FormModal } from "../components/FormModal";
import { CheckboxLabel, TextInput } from "../components/inputs";
import { Modal } from "../components/Modal";
import { Notice } from "../components/Notice";
import { ResourcePage } from "../components/Page";
import { useToast } from "../components/Toast";
import { formatDate, formatQuota } from "../lib/format";
import type { Token } from "../types";

interface FormState {
  /** Set when editing an existing key; absent when issuing a new one. */
  id?: number;
  name: string;
  scopeServices: number[];
  scopeAll: boolean;
  maxRequests: string;
  maxTokens: string;
  expiresAt: string;
  enabled: boolean;
}

const EMPTY: FormState = {
  name: "",
  scopeServices: [],
  scopeAll: true,
  maxRequests: "",
  maxTokens: "",
  expiresAt: "",
  enabled: true,
};

/** A key with no service list may call every service. */
const isUnscoped = (t: Token): boolean => !t.scopeServices || t.scopeServices.length === 0;

function formFromToken(t: Token): FormState {
  return {
    name: t.name,
    scopeServices: t.scopeServices ?? [],
    scopeAll: isUnscoped(t),
    maxRequests: t.maxRequests != null ? String(t.maxRequests) : "",
    maxTokens: t.maxTokens != null ? String(t.maxTokens) : "",
    expiresAt: msToLocalInput(t.expiresAt),
    enabled: t.enabled,
  };
}

export function Tokens() {
  const { t: i18n } = useI18n();
  const isAdmin = useIsAdmin();
  const toast = useToast();
  const state = useAsync(() => loadAll({ tokens: fetchTokens, services: fetchServices }));
  const { data, reload } = state;
  const { confirm, confirmEl } = useConfirm();
  const attempt = useAttempt();
  const fc = useFormState<FormState>();
  const { form } = fc;
  const editing = form?.id != null;
  const [secret, setSecret] = useState<string | null>(null);
  const copy = useCopy({ ok: i18n("tokens.toast.copied"), fail: i18n("tokens.toast.copyFailed") });

  const serviceName = (id: number) => nameById(data?.services, id);

  // Issuing answers with the new key's secret (shown once, no toast); an edit
  // just confirms.
  const { save, saving } = useSave<FormState, { secret: string }>(fc, {
    collection: API.tokens,
    member: API.token,
    toPayload: (f) => {
      // "Not all" with nothing ticked is not a choice: the server reads an
      // empty list as unscoped, the opposite of what the form shows.
      if (!f.scopeAll && f.scopeServices.length === 0) {
        toast.error(i18n("tokens.toast.scopeEmpty"));
        return null;
      }
      const expiresAt =
        f.id != null ? editedExpiry(f.expiresAt, data?.tokens.find((token) => token.id === f.id)?.expiresAt) : editedExpiry(f.expiresAt);
      if (expiresAt === undefined) {
        toast.error(i18n("tokens.toast.invalidExpiry"));
        return null;
      }
      return {
        name: f.name,
        scopeServices: f.scopeAll ? null : f.scopeServices,
        maxRequests: f.maxRequests ? Number(f.maxRequests) : null,
        maxTokens: f.maxTokens ? Number(f.maxTokens) : null,
        expiresAt,
        enabled: f.enabled,
      };
    },
    messages: (isEdit) =>
      isEdit
        ? { success: i18n("tokens.toast.updated"), failed: i18n("tokens.toast.updateFailed") }
        : { failed: i18n("tokens.toast.createFailed") },
    onSaved: (r, f) => {
      if (f.id == null) setSecret(r.secret);
      reload();
    },
  });

  const toggleEnabled = (t: Token) =>
    attempt(async () => {
      await api.patch(API.token(t.id), { enabled: !t.enabled });
      reload();
    }, i18n("common.failed"));

  const del = useDeleteAction(confirm, reload);
  const remove = (t: Token) =>
    del({
      title: i18n("tokens.confirm.revokeTitle"),
      body: i18n("tokens.confirm.revokeBody", { name: t.name }),
      path: API.token(t.id),
      success: i18n("tokens.toast.revoked"),
      fallback: i18n("common.failed"),
    });

  const copyKey = (t: Token) =>
    attempt(async () => {
      const r = await api.post<{ secret: string }>(API.tokenSecret(t.id));
      await copy(r.secret);
    }, i18n("common.failed"));

  /** Open the create form pre-filled from an existing key. Everything carries
   * over except the identity: no `id`, so saving issues a NEW key with its own
   * secret, and the name is suffixed so the two are tellable apart in a list
   * where scope and limits now look identical. */
  const openDuplicate = (t: Token) => fc.open({ ...formFromToken(t), name: i18n("tokens.copyOfName", { name: t.name }) });

  const columns: Column<Token>[] = [
    { header: i18n("tokens.table.name"), className: "font-medium text-ink-100", cell: (t) => t.name },
    { header: i18n("tokens.table.prefix"), className: "font-mono text-xs text-ink-400", cell: (t) => <>{t.keyPrefix}...</> },
    {
      header: i18n("tokens.table.scope"),
      className: "text-xs",
      cell: (t) =>
        isUnscoped(t) ? (
          <span className="badge-gray">{i18n("tokens.scope.all")}</span>
        ) : (
          <span className="text-ink-300">{(t.scopeServices ?? []).map(serviceName).join(", ")}</span>
        ),
    },
    { header: i18n("tokens.table.requests"), className: "text-xs text-ink-300", cell: (t) => formatQuota(t.usedRequests, t.maxRequests) },
    { header: i18n("tokens.table.tokens"), className: "text-xs text-ink-300", cell: (t) => formatQuota(t.usedTokens, t.maxTokens) },
    {
      header: i18n("tokens.table.expires"),
      className: "text-xs text-ink-400",
      cell: (t) => (t.expiresAt ? formatDate(t.expiresAt) : i18n("common.never")),
    },
    {
      header: i18n("tokens.table.status"),
      cell: (t) => (isAdmin ? <Toggle checked={t.enabled} onChange={() => toggleEnabled(t)} /> : <EnabledBadge enabled={t.enabled} />),
    },
    {
      header: i18n("tokens.table.actions"),
      headerClassName: "text-right",
      cell: (t) =>
        isAdmin ? (
          <RowActions
            className="justify-end"
            lead={
              <>
                <Button
                  variant="ghost"
                  size="xs"
                  icon={ACTION_ICON.copy}
                  disabled={!t.hasStoredKey}
                  title={t.hasStoredKey ? undefined : i18n("tokens.copyKey.unavailable")}
                  onClick={() => copyKey(t)}
                >
                  {i18n("tokens.action.copyKey")}
                </Button>
                <Button variant="ghost" size="xs" icon={ACTION_ICON.duplicate} onClick={() => openDuplicate(t)}>
                  {i18n("tokens.action.duplicate")}
                </Button>
              </>
            }
            onEdit={() => fc.open({ ...formFromToken(t), id: t.id })}
            editLabel={i18n("tokens.action.edit")}
            onDelete={() => remove(t)}
            deleteIcon={ACTION_ICON.revoke}
            deleteLabel={i18n("tokens.action.revoke")}
          />
        ) : (
          <RowActions className="justify-end">
            <ReadOnlyNote />
          </RowActions>
        ),
    },
  ];

  return (
    <ResourcePage
      title={i18n("tokens.title")}
      subtitle={i18n("tokens.subtitle")}
      icon={ENTITY_ICON.token}
      action={
        isAdmin ? (
          <Button variant="primary" icon={ACTION_ICON.add} onClick={() => fc.open({ ...EMPTY })}>
            {i18n("tokens.action.issue")}
          </Button>
        ) : (
          <span className="badge-gray"><Icon name="bi-shield-lock" />{i18n("tokens.adminOnlyHint")}</span>
        )
      }
      state={state}
      isEmpty={(d) => d.tokens.length === 0}
      empty={
        <EmptyState
          icon={ENTITY_ICON.token}
          title={i18n("tokens.empty.title")}
          hint={isAdmin ? i18n("tokens.empty.hintAdmin") : i18n("tokens.empty.hintUser")}
        />
      }
    >
      {data && data.tokens.length > 0 && <DataTable rows={data.tokens} rowKey={(t) => t.id} columns={columns} />}

      {/* Create / Edit form */}
      <FormModal
        open={form !== null}
        title={editing ? i18n("tokens.modal.editTitle") : i18n("tokens.modal.createTitle")}
        icon={ENTITY_ICON.token}
        onClose={fc.close}
        size="lg"
        onSubmit={save}
        submitLabel={editing ? i18n("tokens.action.save") : i18n("tokens.action.issueConfirm")}
        cancelLabel={i18n("tokens.action.cancel")}
        busy={saving}
        disabled={!form?.name}
      >
        {form && (
          <div className="space-y-4">
            <Field label={i18n("tokens.form.name")}>
              <TextInput {...fc.bind("name")} placeholder={i18n("tokens.form.namePlaceholder")} />
            </Field>
            <Field label={i18n("tokens.form.scope")}>
              <CheckboxLabel className="mb-2" checked={form.scopeAll} onChange={(on) => fc.set("scopeAll", on)}>
                {i18n("tokens.form.scopeAll")}
              </CheckboxLabel>
              {!form.scopeAll && (
                <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-ink-800 p-2">
                  {data?.services.map((m) => (
                    <CheckboxLabel
                      key={m.id}
                      checked={form.scopeServices.includes(m.id)}
                      onChange={(on) => fc.set("scopeServices", setMember(form.scopeServices, m.id, on))}
                    >
                      <span className="font-mono text-xs">{m.name}</span>
                    </CheckboxLabel>
                  ))}
                  {data?.services.length === 0 && <p className="text-xs text-ink-500">{i18n("tokens.form.noServices")}</p>}
                </div>
              )}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={i18n("tokens.form.maxRequests")}>
                <TextInput type="number" {...fc.bind("maxRequests")} />
              </Field>
              <Field label={i18n("tokens.form.maxTokens")}>
                <TextInput type="number" {...fc.bind("maxTokens")} />
              </Field>
            </div>
            <Field label={i18n("tokens.form.expiresAt")}>
              <TextInput type="datetime-local" {...fc.bind("expiresAt")} />
            </Field>
            <Toggle checked={form.enabled} onChange={(v) => fc.set("enabled", v)} label={i18n("tokens.form.enabled")} />
          </div>
        )}
      </FormModal>

      {/* Reveal-once secret */}
      <Modal
        open={secret !== null}
        title={i18n("tokens.modal.createdTitle")}
        icon="bi-clipboard-check"
        onClose={() => setSecret(null)}
        footer={<Button variant="primary" onClick={() => setSecret(null)}>{i18n("tokens.action.done")}</Button>}
      >
        <div className="space-y-3">
          <Notice tone="warning" size="sm">
            {i18n("tokens.secret.warning")}
          </Notice>
          <div className="flex items-center gap-2">
            <code
              title={i18n("tokens.secret.clickToSelect")}
              onClick={(e) => {
                const range = document.createRange();
                range.selectNodeContents(e.currentTarget);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
              }}
              className="flex-1 cursor-text overflow-x-auto rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 font-mono text-xs text-brand-400"
            >
              {secret}
            </code>
            <Button variant="ghost" icon={ACTION_ICON.copy} onClick={() => secret && void copy(secret)} />
          </div>
        </div>
      </Modal>
      {confirmEl}
    </ResourcePage>
  );
}
