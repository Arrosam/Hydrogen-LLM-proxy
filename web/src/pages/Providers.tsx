import { useEffect, useState } from "react";
import { api } from "../api";
import { useAction, useAsync } from "../lib/hooks";
import { useIsAdmin } from "../auth";
import { patchAt, removeAt } from "../lib/collections";
import { useDeleteAction, useFormState, useSave } from "../lib/crud";
import { API } from "../lib/endpoints";
import { ACTION_ICON, ENTITY_ICON } from "../lib/icons";
import { formatJson } from "../lib/json";
import { fetchProviderModels, fetchProviders, fetchProxies, loadAll } from "../lib/resources";
import { EnabledBadge, ReadOnlyNote } from "../components/badges";
import { Button, Icon } from "../components/Button";
import { EmptyState, Toggle, useConfirm } from "../components/common";
import { DataTable, type Column } from "../components/DataTable";
import { RowActions } from "../components/EntityCard";
import { Field } from "../components/Field";
import { FormModal } from "../components/FormModal";
import { Select, TextArea, TextInput } from "../components/inputs";
import { ModelList } from "../components/ModelList";
import { ResourcePage } from "../components/Page";
import { useToast } from "../components/Toast";
import { useI18n } from "../lib/i18n";
import { PROVIDER_TYPES, type Provider, type ProviderTestResult, type ProviderType, type Proxy } from "../types";

/** The outcome of the last test run inside the modal. */
interface TestState {
  ok: boolean;
  message: string;
  /** What the provider reported. Saved with the provider on Save. */
  models: string[];
}

type AltEndpoint = NonNullable<Provider["altEndpoints"]>[number];

interface FormState {
  id?: number;
  name: string;
  type: ProviderType;
  baseUrl: string;
  altEndpoints: AltEndpoint[];
  apiKey: string;
  extraHeaders: string;
  maxOutputTokens: string;
  /** "" = direct connection; otherwise the id of a saved proxy. */
  proxyId: string;
  enabled: boolean;
  /** The list already stored for this provider (edit only), shown until a test
   * replaces it. */
  storedModels: string[];
  /** Null until the provider is tested in this dialog; a successful test's list
   * is what gets written on Save. */
  test: TestState | null;
}

const EMPTY: FormState = {
  name: "",
  type: "openai_completion",
  baseUrl: "",
  altEndpoints: [],
  apiKey: "",
  extraHeaders: "",
  maxOutputTokens: "",
  proxyId: "",
  enabled: true,
  storedModels: [],
  test: null,
};

/** A provider answers on its own endpoint plus at most this many alternates. */
const MAX_ALT_ENDPOINTS = 3;
/** A positive integer with no leading zero. */
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const ALT_ENDPOINT_PLACEHOLDER = "https://…/v1";
const EXTRA_HEADERS_PLACEHOLDER = '{"x-custom": "value"}';
const EXTRA_HEADERS_ROWS = 3;

/** The type a new alternate endpoint starts on: not the one the provider already speaks. */
const otherType = (type: ProviderType): ProviderType => (type === "openai_completion" ? "openai_responses" : "openai_completion");

export function Providers() {
  const { t } = useI18n();
  // Provider rows carry upstream credentials; every mutation (including
  // "test with the stored key") is admin-only on the server. Managers get the
  // read-only view the catalog and service editors need.
  const isAdmin = useIsAdmin();
  const typeOptions = PROVIDER_TYPES.map((type) => ({ value: type, label: t(`providers.type.${type}`) }));
  const state = useAsync(() => loadAll({ providers: fetchProviders, providerModels: fetchProviderModels }));
  const { data, reload } = state;
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const fc = useFormState<FormState>();
  const { form } = fc;
  // Only for the egress-proxy dropdown. Never gates anything: a provider with
  // no proxy is the default and every existing provider stays that way.
  const [proxies, setProxies] = useState<Proxy[]>([]);

  useEffect(() => {
    fetchProxies()
      .then(setProxies)
      .catch(() => setProxies([]));
  }, []);
  const testing = useAction();

  const storedFor = (providerId: number) => data?.providerModels.find((x) => x.providerId === providerId)?.models ?? [];

  const openNew = () => fc.open({ ...EMPTY });
  const openEdit = (p: Provider) =>
    fc.open({
      id: p.id,
      name: p.name,
      type: p.type,
      baseUrl: p.baseUrl,
      altEndpoints: p.altEndpoints ?? [],
      apiKey: "",
      extraHeaders: p.extraHeaders ? formatJson(p.extraHeaders) : "",
      maxOutputTokens: p.maxOutputTokens != null ? String(p.maxOutputTokens) : "",
      proxyId: p.proxyId != null ? String(p.proxyId) : "",
      enabled: p.enabled,
      storedModels: storedFor(p.id),
      test: null,
    });

  /** Parse the extra-headers textarea, reporting the failure the same way for
   * both the test and the save (both send headers upstream). */
  const parseHeaders = (raw: string): Record<string, string> | null | "invalid" => {
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      toast.error(t("providers.toast.extraHeadersInvalidJson"));
      return "invalid";
    }
  };

  const test = async () => {
    if (!form) return;
    if (!form.baseUrl.trim()) {
      toast.error(t("providers.toast.baseUrlRequired"));
      return;
    }
    const extraHeaders = parseHeaders(form.extraHeaders);
    if (extraHeaders === "invalid") return;
    await testing.run(
      async () => {
        const payload: Record<string, unknown> = { type: form.type, baseUrl: form.baseUrl, extraHeaders };
        // A blank key field on an existing provider means "keep the stored one",
        // so let the server use it rather than testing with no key at all.
        if (form.apiKey) payload.apiKey = form.apiKey;
        else if (form.id) payload.id = form.id;
        else payload.apiKey = null;
        // The proxy selected in the form, so a test proves the route a real
        // request would take -- including a proxy chosen but not yet saved.
        payload.proxyId = form.proxyId ? Number(form.proxyId) : null;
        const r = await api.post<ProviderTestResult>(API.providersTest, payload);
        fc.patch({ test: { ok: r.ok, message: r.message, models: r.models } });
        if (!r.ok) toast.error(r.message);
        else if (r.models.length === 0) toast.error(t("providers.toast.testNoModels"));
        else toast.success(t("providers.toast.testFetched", { count: r.models.length }));
      },
      t("providers.toast.testFailed"),
      (message) => {
        fc.patch({ test: { ok: false, message, models: [] } });
        toast.error(message);
      },
    );
  };

  const { save, saving } = useSave(fc, {
    collection: API.providers,
    member: API.provider,
    toPayload: (f) => {
      const extraHeaders = parseHeaders(f.extraHeaders);
      if (extraHeaders === "invalid") return null;
      const motRaw = f.maxOutputTokens.trim();
      if (motRaw && !POSITIVE_INTEGER.test(motRaw)) {
        toast.error(t("providers.toast.maxOutputTokensNotPositive"));
        return null;
      }
      const altEndpoints = f.altEndpoints.filter((e) => e.baseUrl.trim());
      const payload: Record<string, unknown> = {
        name: f.name,
        type: f.type,
        baseUrl: f.baseUrl,
        extraHeaders,
        maxOutputTokens: motRaw ? Number(motRaw) : null,
        proxyId: f.proxyId ? Number(f.proxyId) : null,
        altEndpoints: altEndpoints.length ? altEndpoints : null,
        enabled: f.enabled,
      };
      // A blank key on an existing provider keeps the stored one: the field is left out.
      if (f.apiKey) payload.apiKey = f.apiKey;
      // Only a successful test writes the model list; omitting the field leaves
      // whatever is stored untouched.
      if (f.test?.ok) payload.availableModels = f.test.models;
      return payload;
    },
    messages: (editing) => ({
      success: t(editing ? "providers.toast.updated" : "providers.toast.created"),
      failed: t("common.saveFailed"),
    }),
    onSaved: reload,
  });

  const del = useDeleteAction(confirm, reload);
  const remove = (p: Provider) =>
    del({
      title: t("providers.confirm.delete.title"),
      body: t("providers.confirm.delete.body", { name: p.name }),
      path: API.provider(p.id),
      success: t("providers.toast.deleted"),
      fallback: t("providers.toast.deleteFailed"),
    });

  // The list shown in the dialog: the fresh one once tested, else what's stored.
  const shownModels = form?.test?.ok ? form.test.models : (form?.storedModels ?? []);

  const newButton = isAdmin ? (
    <Button variant="primary" icon={ACTION_ICON.add} onClick={openNew}>
      {t("providers.action.new")}
    </Button>
  ) : undefined;

  const noneBadge = (
    <span className="badge-gray"><Icon name="bi-dash" />{t("common.none")}</span>
  );

  const columns: Column<Provider>[] = [
    { header: t("providers.table.name"), className: "font-medium text-ink-100", cell: (p) => p.name },
    { header: t("providers.table.type"), cell: (p) => <span className="badge-gray">{t(`providers.type.${p.type}`)}</span> },
    {
      header: t("providers.table.baseUrl"),
      className: "font-mono text-xs text-ink-400 max-w-[240px] truncate",
      title: (p) => p.baseUrl,
      cell: (p) => p.baseUrl,
    },
    {
      header: t("providers.table.key"),
      cell: (p) => (p.hasKey ? <span className="badge-green"><Icon name="bi-key-fill" />{t("common.set")}</span> : noneBadge),
    },
    {
      header: t("providers.table.models"),
      cell: (p) => {
        const count = storedFor(p.id).length;
        return count > 0 ? <span className="badge-blue"><Icon name={ENTITY_ICON.model} />{count}</span> : noneBadge;
      },
    },
    { header: t("providers.table.status"), cell: (p) => <EnabledBadge enabled={p.enabled} /> },
    {
      header: t("providers.table.actions"),
      headerClassName: "text-right",
      cell: (p) =>
        isAdmin ? <RowActions className="justify-end" onEdit={() => openEdit(p)} onDelete={() => remove(p)} /> : <ReadOnlyNote />,
    },
  ];

  return (
    <ResourcePage
      title={t("providers.title")}
      subtitle={t("providers.subtitle")}
      icon={ENTITY_ICON.provider}
      action={newButton}
      state={state}
      isEmpty={(d) => d.providers.length === 0}
      empty={
        <EmptyState icon={ENTITY_ICON.provider} title={t("providers.empty.title")} hint={t("providers.empty.hint")} action={newButton} />
      }
    >
      {data && data.providers.length > 0 && <DataTable rows={data.providers} rowKey={(p) => p.id} columns={columns} />}

      <FormModal
        open={form !== null}
        size="lg"
        title={form?.id ? t("providers.modal.edit.title") : t("providers.modal.new.title")}
        icon={ENTITY_ICON.provider}
        onClose={fc.close}
        onSubmit={save}
        submitLabel={t("common.save")}
        busy={saving}
        spinWhenBusy
      >
        {form && (
          <div className="space-y-4">
            {/* The short fields pair up; anything that holds a URL, a JSON blob
                or a list keeps the full width. */}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("providers.field.name.label")}>
                <TextInput {...fc.bind("name")} placeholder={t("providers.field.name.placeholder")} />
              </Field>
              <Field label={t("providers.field.type.label")}>
                <Select value={form.type} onChange={(type) => fc.set("type", type)} options={typeOptions} />
              </Field>
            </div>
            <Field
              label={t("providers.field.baseUrl.label")}
              hint={
                form.type === "anthropic"
                  ? t("providers.field.baseUrl.hint.anthropic")
                  : form.type === "openai_responses"
                    ? t("providers.field.baseUrl.hint.openai_responses")
                    : t("providers.field.baseUrl.hint.openai_completion")
              }
            >
              <TextInput
                mono
                {...fc.bind("baseUrl")}
                placeholder={
                  form.type === "anthropic" ? t("providers.field.baseUrl.placeholder.anthropic") : t("providers.field.baseUrl.placeholder.openai")
                }
              />
            </Field>
            <Field
              label={t("providers.field.altEndpoints.label")}
              suffix={t("providers.field.altEndpoints.optional")}
              hint={t("providers.field.altEndpoints.hint")}
              hintPosition="above-loose"
            >
              {form.altEndpoints.map((ep, i) => (
                <div key={i} className="mb-2 flex gap-2">
                  <Select
                    className="w-48"
                    value={ep.type}
                    onChange={(type) => fc.set("altEndpoints", patchAt(form.altEndpoints, i, { type }))}
                    options={typeOptions}
                  />
                  <TextInput
                    mono
                    value={ep.baseUrl}
                    onChange={(e) => fc.set("altEndpoints", patchAt(form.altEndpoints, i, { baseUrl: e.target.value }))}
                    placeholder={ALT_ENDPOINT_PLACEHOLDER}
                  />
                  <Button variant="ghost" size="xs" icon={ACTION_ICON.close} onClick={() => fc.set("altEndpoints", removeAt(form.altEndpoints, i))} />
                </div>
              ))}
              {form.altEndpoints.length < MAX_ALT_ENDPOINTS && (
                <Button
                  variant="ghost"
                  size="xs"
                  icon={ACTION_ICON.add}
                  onClick={() => fc.set("altEndpoints", [...form.altEndpoints, { type: otherType(form.type), baseUrl: "" }])}
                >
                  {t("providers.field.altEndpoints.add")}
                </Button>
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("providers.field.apiKey.label")} suffix={form.id ? t("providers.field.apiKey.keepCurrentHint") : false}>
                <TextInput mono type="password" {...fc.bind("apiKey")} placeholder={t("providers.field.apiKey.placeholder")} />
              </Field>
              <Field
                label={t("providers.field.maxOutputTokens.label")}
                suffix={t("providers.field.maxOutputTokens.optionalCap")}
                hint={t("providers.field.maxOutputTokens.hint")}
              >
                <TextInput mono inputMode="numeric" {...fc.bind("maxOutputTokens")} placeholder={t("providers.field.maxOutputTokens.placeholder")} />
              </Field>
            </div>
            <Field label={t("providers.field.proxy.label")} hint={t("providers.field.proxy.hint")}>
              <Select
                value={form.proxyId}
                onChange={(proxyId) => fc.set("proxyId", proxyId)}
                placeholder={t("providers.field.proxy.direct")}
                options={proxies.map((p) => ({
                  value: String(p.id),
                  label: `${p.name} — ${p.scheme}://${p.host}:${p.port}${p.enabled ? "" : ` (${t("common.disabled")})`}`,
                }))}
              />
            </Field>
            <Field label={t("providers.field.extraHeaders.label")}>
              <TextArea mono rows={EXTRA_HEADERS_ROWS} {...fc.bind("extraHeaders")} placeholder={EXTRA_HEADERS_PLACEHOLDER} />
            </Field>

            <div className="rounded-lg border border-ink-800 bg-ink-950/30 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t("providers.test.title")}</div>
                  <p className="mt-1 text-xs text-ink-500">{t("providers.test.hint")}</p>
                </div>
                <Button variant="ghost" size="xs" className="shrink-0" icon={ACTION_ICON.test} busy={testing.busy} spinWhenBusy onClick={test}>
                  {t("providers.action.test")}
                </Button>
              </div>

              {form.test && !form.test.ok && (
                <p className="mt-3 flex items-start gap-2 text-xs text-red-300">
                  <Icon name="bi-exclamation-octagon-fill" className="mt-px shrink-0" />
                  <span className="break-words">{form.test.message}</span>
                </p>
              )}

              {(shownModels.length > 0 || form.test?.ok) && (
                <div className="mt-3 space-y-2">
                  <div className="flex items-center gap-2 text-xs">
                    {form.test?.ok ? (
                      <span className="badge-green"><Icon name={ACTION_ICON.save} />{t("providers.test.fetched", { count: form.test.models.length })}</span>
                    ) : (
                      <span className="badge-gray"><Icon name="bi-clock-history" />{t("providers.test.stored", { count: shownModels.length })}</span>
                    )}
                    {form.test?.ok && <span className="text-ink-500">{t("providers.test.savedOnSave")}</span>}
                  </div>
                  <ModelList models={shownModels} emptyText={t("providers.test.none")} />
                </div>
              )}
            </div>

            <Toggle checked={form.enabled} onChange={(v) => fc.set("enabled", v)} label={t("providers.field.enabled.label")} />
          </div>
        )}
      </FormModal>
      {confirmEl}
    </ResourcePage>
  );
}
