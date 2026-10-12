import { api } from "../api";
import { useAction, useAsync } from "../lib/hooks";
import { useIsAdmin } from "../auth";
import { useDeleteAction, useFormState, useSave } from "../lib/crud";
import { API } from "../lib/endpoints";
import { ACTION_ICON, ENTITY_ICON } from "../lib/icons";
import { fetchProxies } from "../lib/resources";
import { EnabledBadge } from "../components/badges";
import { Button, Icon } from "../components/Button";
import { EmptyState, Toggle, useConfirm } from "../components/common";
import { EntityCard, RowActions } from "../components/EntityCard";
import { Field } from "../components/Field";
import { FormModal } from "../components/FormModal";
import { Select, TextInput } from "../components/inputs";
import { Notice } from "../components/Notice";
import { ResourcePage } from "../components/Page";
import { useToast } from "../components/Toast";
import { useI18n } from "../lib/i18n";
import type { Proxy, ProxyTestResult } from "../types";

/**
 * Egress proxies: the optional network hop between Hydrogen and a provider.
 *
 * Nothing here changes what is sent upstream or how an answer is read -- a
 * proxy only changes how the connection is opened. A provider picks one in the
 * Providers editor; until it does, it connects directly, which is what every
 * provider did before this tab existed.
 */

type Scheme = Proxy["scheme"];

interface FormState {
  id?: number;
  name: string;
  scheme: Scheme;
  host: string;
  port: string;
  username: string;
  /** Blank on edit means "keep the stored password". */
  password: string;
  enabled: boolean;
  test: ProxyTestResult | null;
}

const SCHEMES: readonly Scheme[] = ["http", "https"];
const DEFAULT_PROXY_PORT = "7890";
const PORT_RANGE = { min: 1, max: 65535 } as const;
const HOST_PLACEHOLDER = "127.0.0.1";

const EMPTY: FormState = {
  name: "",
  scheme: "http",
  host: "",
  port: DEFAULT_PROXY_PORT,
  username: "",
  password: "",
  enabled: true,
  test: null,
};

export function Proxies() {
  const { t } = useI18n();
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const isAdmin = useIsAdmin();

  const state = useAsync(fetchProxies);
  const { data, reload } = state;
  const fc = useFormState<FormState>();
  const { form } = fc;
  const testing = useAction();

  const openEdit = (p: Proxy): void =>
    fc.open({
      id: p.id,
      name: p.name,
      scheme: p.scheme,
      host: p.host,
      port: String(p.port),
      username: p.username ?? "",
      password: "",
      enabled: p.enabled,
      test: null,
    });

  /** The editor's fields as the API wants them, or null when they do not add up. */
  const payload = (f: FormState): Record<string, unknown> | null => {
    const port = Number(f.port.trim());
    if (!Number.isInteger(port) || port < PORT_RANGE.min || port > PORT_RANGE.max) {
      toast.error(t("proxies.toast.portInvalid"));
      return null;
    }
    if (!f.host.trim()) {
      toast.error(t("proxies.toast.hostRequired"));
      return null;
    }
    return {
      name: f.name.trim(),
      scheme: f.scheme,
      host: f.host.trim(),
      port,
      username: f.username.trim() || null,
      enabled: f.enabled,
    };
  };

  /**
   * Prove the proxy actually carries traffic, before a provider depends on it.
   * An unsaved proxy is testable too -- finding out after saving that a port
   * was wrong is the workflow this avoids.
   */
  const test = async (): Promise<void> => {
    if (!form) return;
    const body = payload(form);
    if (!body) return;
    await testing.run(async () => {
      const inline = { ...body, ...(form.password ? { password: form.password } : {}) };
      // A saved proxy with an untouched password field is tested by id, so the
      // stored password is used; anything else is tested exactly as typed.
      const req = form.id && !form.password ? { id: form.id } : { proxy: inline };
      const r = await api.post<ProxyTestResult>(API.proxiesTest, req);
      fc.patch({ test: r });
      if (r.ok) toast.success(t("proxies.toast.reachable"));
      else toast.error(t("proxies.toast.unreachable"));
    }, t("proxies.toast.testFailed"));
  };

  const { save, saving } = useSave(fc, {
    collection: API.proxies,
    member: API.proxy,
    toPayload: (f) => {
      const body = payload(f);
      if (body && f.password) body.password = f.password;
      return body;
    },
    messages: (editing) => ({
      success: t(editing ? "proxies.toast.updated" : "proxies.toast.created"),
      failed: t("common.saveFailed"),
    }),
    onSaved: reload,
  });

  const del = useDeleteAction(confirm, reload);
  // A proxy still attached to a provider is refused, and the message names
  // which providers -- so the server's text is the useful thing to surface.
  const remove = (p: Proxy): Promise<void> =>
    del({
      title: t("proxies.confirm.deleteTitle"),
      body: t("proxies.confirm.deleteBody", { name: p.name }),
      path: API.proxy(p.id),
      success: t("proxies.toast.deleted"),
      fallback: t("common.deleteFailed"),
    });

  return (
    <ResourcePage
      title={t("proxies.title")}
      subtitle={t("proxies.subtitle")}
      icon={ENTITY_ICON.proxy}
      action={
        isAdmin ? (
          <Button variant="primary" icon={ACTION_ICON.add} onClick={() => fc.open({ ...EMPTY })}>
            {t("proxies.new")}
          </Button>
        ) : undefined
      }
      state={state}
      loadingLabel={t("proxies.loading")}
      isEmpty={(list) => list.length === 0}
      empty={<EmptyState icon={ENTITY_ICON.proxy} title={t("proxies.empty.title")} hint={t("proxies.empty.body")} />}
    >
      {data && data.length > 0 && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {data.map((p) => (
            <EntityCard
              key={p.id}
              icon={ENTITY_ICON.proxy}
              title={p.name}
              badges={<EnabledBadge enabled={p.enabled} offTone="gray" />}
              shrinkText
              gap
              details={
                <>
                  <div className="mt-1 font-mono text-xs text-ink-400">
                    {p.scheme}://{p.username ? `${p.username}@` : ""}{p.host}:{p.port}
                  </div>
                  {p.hasPassword && (
                    <div className="mt-1 text-xs text-ink-500">
                      <Icon name={ENTITY_ICON.token} className="mr-1" />
                      {t("proxies.hasPassword")}
                    </div>
                  )}
                </>
              }
              aside={
                isAdmin && (
                  <RowActions
                    className="shrink-0"
                    onEdit={() => openEdit(p)}
                    editLabel={t("common.edit")}
                    onDelete={() => void remove(p)}
                    deleteIcon={ACTION_ICON.removeAlt}
                  />
                )
              }
            />
          ))}
        </div>
      )}

      <FormModal
        open={form !== null}
        title={form?.id ? t("proxies.modal.editTitle", { name: form.name }) : t("proxies.modal.newTitle")}
        icon={ENTITY_ICON.proxy}
        onClose={fc.close}
        onSubmit={() => void save()}
        submitLabel={t("common.save")}
        busy={saving}
        disabled={!form?.name.trim()}
        footerStart={
          <Button variant="ghost" icon={ACTION_ICON.test} busy={testing.busy} spinWhenBusy onClick={() => void test()}>
            {testing.busy ? t("proxies.testing") : t("proxies.test")}
          </Button>
        }
      >
        {form && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Field label={t("proxies.field.name")}>
                <TextInput {...fc.bind("name")} placeholder={t("proxies.field.name.placeholder")} />
              </Field>
              <Field label={t("proxies.field.scheme")}>
                <Select
                  value={form.scheme}
                  onChange={(scheme) => fc.set("scheme", scheme)}
                  options={SCHEMES.map((scheme) => ({ value: scheme, label: scheme }))}
                />
              </Field>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <Field className="col-span-2" label={t("proxies.field.host")}>
                <TextInput mono {...fc.bind("host")} placeholder={HOST_PLACEHOLDER} />
              </Field>
              <Field label={t("proxies.field.port")}>
                <TextInput mono inputMode="numeric" {...fc.bind("port")} />
              </Field>
            </div>
            <p className="-mt-2 text-xs text-ink-500">{t("proxies.field.host.hint")}</p>

            <div className="grid grid-cols-2 gap-4">
              <Field label={t("proxies.field.username")} suffix={t("common.optional")}>
                <TextInput {...fc.bind("username")} autoComplete="off" />
              </Field>
              <Field label={t("proxies.field.password")} suffix={form.id ? t("proxies.field.password.keepHint") : false}>
                <TextInput type="password" {...fc.bind("password")} autoComplete="new-password" />
              </Field>
            </div>

            <Toggle checked={form.enabled} onChange={(v) => fc.set("enabled", v)} label={t("common.enabled")} />
            <p className="text-xs text-ink-500">{t("proxies.field.enabled.hint")}</p>

            {form.test && (
              <Notice tone={form.test.ok ? "success" : "error"} layout="inline">
                {form.test.message}
                {form.test.ok && <span className="ml-2 text-ink-500">{form.test.latencyMs} {t("common.ms")}</span>}
              </Notice>
            )}
          </div>
        )}
      </FormModal>
      {confirmEl}
    </ResourcePage>
  );
}
