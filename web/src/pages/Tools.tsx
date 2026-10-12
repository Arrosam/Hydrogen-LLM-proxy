import { useState } from "react";
import { api } from "../api";
import { useAction, useAsync } from "../lib/hooks";
import { useDeleteAction, useFields } from "../lib/crud";
import { API } from "../lib/endpoints";
import { errorMessage } from "../lib/errors";
import { ACTION_ICON, ENTITY_ICON } from "../lib/icons";
import { useI18n } from "../lib/i18n";
import { formatJson } from "../lib/json";
import { fetchTools } from "../lib/resources";
import { Button } from "../components/Button";
import { ErrorNote, Toggle, useConfirm } from "../components/common";
import { Field } from "../components/Field";
import { TextArea, TextInput } from "../components/inputs";
import { Modal } from "../components/Modal";
import { BoundedIntInput } from "../components/numeric";
import { ResourcePage } from "../components/Page";
import { useToast } from "../components/Toast";
import type { HostedTool, ServerToolContract } from "../types";

const SAMPLE_SCHEMA = { type: "object", properties: { query: { type: "string", description: "Search query" } }, required: ["query"], additionalProperties: false };
const SAMPLE_BODY = { tool: "{{tool.name}}", arguments: "{{arguments}}", session_id: "{{session.id}}", call_id: "{{call.id}}" };
const SAMPLE_ARGUMENTS = '{"query":"example"}';
const SAMPLE_RESULT = '{"result":{"answer":"example"}}';
/** The tool name the mapping preview uses while the name field is still empty. */
const PREVIEW_TOOL_NAME = "example";

const TOOL_NAME_MAX = 64;
const RESULT_TYPE_MAX = 128;
const DEFAULT_RESULT_PATH = "/result";
const DEFAULT_RESULT_TYPE = "web_search_result";
const TIMEOUT_MS = { default: 30000, min: 100, max: 600000 } as const;
const RESULT_BYTES = { default: 65536, min: 1, max: 1048576 } as const;
/** Heights (rows) of the editor's two kinds of JSON box. */
const DEFINITION_ROWS = 10;
const SAMPLE_ROWS = 3;

export function Tools() {
  const { t } = useI18n();
  const state = useAsync(fetchTools);
  const { data, reload } = state;
  const { confirm, confirmEl } = useConfirm();
  const [editing, setEditing] = useState<HostedTool | null | undefined>(undefined);
  const del = useDeleteAction(confirm, reload);
  const remove = (tool: HostedTool) =>
    del({
      title: t("tools.confirm.deleteTitle"),
      body: t("tools.confirm.deleteBody", { name: tool.name }),
      path: API.tool(tool.id),
      success: t("tools.toast.deleted"),
      fallback: t("common.deleteFailed"),
    });
  return (
    <ResourcePage
      title={t("tools.title")}
      icon={ENTITY_ICON.tool}
      subtitle={t("tools.subtitle")}
      action={<Button variant="primary" icon={ACTION_ICON.add} onClick={() => setEditing(null)}>{t("tools.action.register")}</Button>}
      state={state}
    >
      <div className="space-y-3">
        {data?.map((tool) => (
          <article className="card flex items-center justify-between gap-4 p-5" key={tool.id}>
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <h2 className="font-semibold">{tool.name}</h2>
                <span className={tool.enabled ? "text-xs text-brand-400" : "text-xs text-ink-500"}>{tool.enabled ? t("tools.state.enabled") : t("tools.state.disabled")}</span>
              </div>
              <p className="mt-1 text-sm text-ink-400">{tool.description}</p>
              <p className="mt-2 truncate font-mono text-xs text-ink-500">POST {tool.url}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" onClick={() => setEditing(tool)}>{t("common.edit")}</Button>
              <Button variant="ghost" onClick={() => void remove(tool)}>{t("common.delete")}</Button>
            </div>
          </article>
        ))}
      </div>
      {data && !data.length && (
        <div className="card p-10 text-center">
          <i className={`bi ${ENTITY_ICON.tool} text-3xl text-brand-400`} />
          <h2 className="mt-4 font-semibold">{t("tools.empty.title")}</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-ink-400">{t("tools.empty.hint")}</p>
        </div>
      )}
      {editing !== undefined && <ToolEditor tool={editing} onClose={() => setEditing(undefined)} onSaved={reload} />}
      {confirmEl}
    </ResourcePage>
  );
}

interface ToolForm {
  name: string;
  description: string;
  url: string;
  schema: string;
  template: string;
  headers: string;
  resultPath: string;
  timeoutMs: number;
  maxResultBytes: number;
  enabled: boolean;
  // A tool declares the client-side contract it answers; absent, the tool keeps
  // the plain behaviour (the model uses it, the client sees only the answer).
  serverToolOn: boolean;
  serverToolName: string;
  serverToolResultType: string;
  serverToolResultPath: string;
  argumentsJson: string;
  resultJson: string;
}

const toolForm = (tool: HostedTool | null): ToolForm => ({
  name: tool?.name ?? "",
  description: tool?.description ?? "",
  url: tool?.url ?? "",
  schema: formatJson(tool?.parameters ?? SAMPLE_SCHEMA),
  template: formatJson(tool?.bodyTemplate ?? SAMPLE_BODY),
  headers: "",
  resultPath: tool?.resultPath ?? DEFAULT_RESULT_PATH,
  timeoutMs: tool?.timeoutMs ?? TIMEOUT_MS.default,
  maxResultBytes: tool?.maxResultBytes ?? RESULT_BYTES.default,
  enabled: tool?.enabled ?? true,
  serverToolOn: tool?.serverTool !== undefined,
  serverToolName: tool?.serverTool?.name ?? "",
  serverToolResultType: tool?.serverTool?.resultType ?? DEFAULT_RESULT_TYPE,
  serverToolResultPath: tool?.serverTool?.resultPath ?? "",
  argumentsJson: SAMPLE_ARGUMENTS,
  resultJson: SAMPLE_RESULT,
});

function ToolEditor({ tool, onClose, onSaved }: { tool: HostedTool | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n(), toast = useToast();
  const { values: f, set, bind } = useFields<ToolForm>(() => toolForm(tool));
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  // Save and preview share one flag, and both report inline rather than by toast.
  const action = useAction({ onError: setError });
  /** The request built from the form, or null (reported inline) when the form does not add up: bad JSON, a missing name. */
  const fromForm = <T,>(build: () => T): T | null => {
    setError("");
    try {
      return build();
    } catch (e) {
      setError(errorMessage(e));
      return null;
    }
  };
  const save = async () => {
    const value = fromForm(() => {
      const serverTool: ServerToolContract | undefined = f.serverToolOn
        ? { name: f.serverToolName.trim(), resultType: f.serverToolResultType.trim() || DEFAULT_RESULT_TYPE, resultPath: f.serverToolResultPath.trim() }
        : undefined;
      if (serverTool && !serverTool.name) throw new Error(t("tools.error.serverToolName"));
      return { name: f.name, description: f.description, url: f.url, parameters: JSON.parse(f.schema), bodyTemplate: JSON.parse(f.template), resultPath: f.resultPath, timeoutMs: f.timeoutMs, maxResultBytes: f.maxResultBytes, enabled: f.enabled, ...(serverTool ? { serverTool } : {}),
        ...(f.headers.trim() ? { headers: JSON.parse(f.headers) } : tool ? {} : { headers: {} }) };
    });
    if (!value) return;
    await action.run(async () => {
      if (tool) await api.patch(API.tool(tool.id), value); else await api.post(API.tools, value);
      toast.success(t("tools.toast.saved")); onSaved(); onClose();
    }, t("common.saveFailed"));
  };
  const tryPreview = async () => {
    const request = fromForm(() => ({ toolName: f.name || PREVIEW_TOOL_NAME, bodyTemplate: JSON.parse(f.template), arguments: JSON.parse(f.argumentsJson), result: JSON.parse(f.resultJson), resultPath: f.resultPath }));
    if (!request) return;
    await action.run(async () => {
      setPreview(formatJson(await api.post(API.toolsPreview, request)));
    }, t("tools.preview.failed"));
  };
  const area = (label: string, key: "schema" | "template" | "argumentsJson" | "resultJson", rows: number) => (
    <Field as="label" className="block" label={label}>
      <TextArea mono className="w-full" rows={rows} {...bind(key)} spellCheck={false} />
    </Field>
  );
  return (
    <Modal open title={tool ? t("tools.modal.editTitle", { name: tool.name }) : t("tools.modal.createTitle")} onClose={onClose} size="xl">
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field as="label" label={t("tools.form.name")}>
            <TextInput {...bind("name")} maxLength={TOOL_NAME_MAX} placeholder="search_documents" />
          </Field>
          <Field as="label" label={t("tools.form.description")}>
            <TextInput {...bind("description")} />
          </Field>
        </div>
        <Field as="label" className="block" label="POST URL">
          <TextInput className="w-full font-mono" type="url" placeholder="https://adapter.example.com/tools/call" {...bind("url")} />
        </Field>
        <Field
          as="label"
          className="block"
          label={t("tools.form.headers")}
          hint={<>{t("tools.form.headers.hint")}{tool?.headerNames.length ? ` ${tool.headerNames.join(", ")}` : ""}</>}
        >
          <TextInput className="w-full font-mono" type="password" autoComplete="new-password" placeholder={'{"Authorization":"Bearer …"}'} {...bind("headers")} />
        </Field>
        <div className="grid gap-4 lg:grid-cols-2">
          {area(t("tools.form.schema"), "schema", DEFINITION_ROWS)}
          {area(t("tools.form.template"), "template", DEFINITION_ROWS)}
        </div>
        <p className="rounded-lg bg-ink-800 p-3 text-xs leading-relaxed text-ink-300">{t("tools.form.template.hint")}</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field as="label" label={t("tools.form.resultPath")} hint={t("tools.form.resultPath.hint")}>
            <TextInput placeholder={DEFAULT_RESULT_PATH} {...bind("resultPath")} />
          </Field>
          <Field as="label" label={t("tools.form.timeoutMs")}>
            <BoundedIntInput value={f.timeoutMs} onChange={(v) => set("timeoutMs", v)} limits={TIMEOUT_MS} fallback={TIMEOUT_MS.default} />
          </Field>
          <Field as="label" label={t("tools.form.maxResultBytes")}>
            <BoundedIntInput value={f.maxResultBytes} onChange={(v) => set("maxResultBytes", v)} limits={RESULT_BYTES} fallback={RESULT_BYTES.default} />
          </Field>
        </div>
        <details className="rounded-lg border border-ink-700 p-4">
          <summary className="cursor-pointer text-sm font-medium">{t("tools.serverTool.summary")}</summary>
          <p className="mt-2 text-xs leading-relaxed text-ink-500">{t("tools.serverTool.hint")}</p>
          <div className="mt-3">
            <Toggle checked={f.serverToolOn} onChange={(v) => set("serverToolOn", v)} label={t("tools.serverTool.toggle")} />
          </div>
          {f.serverToolOn && (
            <div className="mt-3 space-y-4">
              <Field as="label" className="block" label={t("tools.serverTool.name")}>
                <TextInput className="w-full font-mono" maxLength={TOOL_NAME_MAX} placeholder="web_search" {...bind("serverToolName")} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field as="label" label={t("tools.serverTool.resultType")}>
                  <TextInput className="w-full font-mono" maxLength={RESULT_TYPE_MAX} placeholder={DEFAULT_RESULT_TYPE} {...bind("serverToolResultType")} />
                </Field>
                <Field as="label" label={t("tools.serverTool.resultPath")} hint={t("tools.serverTool.resultPath.hint")}>
                  <TextInput className="w-full font-mono" placeholder="/results" {...bind("serverToolResultPath")} />
                </Field>
              </div>
              <p className="rounded-lg bg-ink-800 p-3 text-xs leading-relaxed text-ink-300">{t("tools.serverTool.example")}</p>
            </div>
          )}
        </details>
        <details className="rounded-lg border border-ink-700 p-4">
          <summary className="cursor-pointer text-sm font-medium">{t("tools.preview.summary")}</summary>
          <div className="mt-4 space-y-3">
            <div className="grid gap-4 sm:grid-cols-2">
              {area(t("tools.preview.arguments"), "argumentsJson", SAMPLE_ROWS)}
              {area(t("tools.preview.result"), "resultJson", SAMPLE_ROWS)}
            </div>
            <Button variant="ghost" busy={action.busy} onClick={() => void tryPreview()}>{t("tools.preview.run")}</Button>
            {preview && <pre className="overflow-auto rounded bg-ink-950 p-3 text-xs">{preview}</pre>}
          </div>
        </details>
        <Toggle checked={f.enabled} onChange={(v) => set("enabled", v)} label={t("tools.form.enabled")} />
        {error && <ErrorNote message={error} />}
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" busy={action.busy} onClick={() => void save()}>{t("tools.action.save")}</Button>
        </div>
      </div>
    </Modal>
  );
}
