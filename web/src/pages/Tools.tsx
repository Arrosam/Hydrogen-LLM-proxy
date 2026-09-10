import { useState } from "react";
import { api } from "../api";
import { useAsync } from "../lib/hooks";
import { useI18n } from "../lib/i18n";
import { PageHeader } from "../components/Layout";
import { Modal } from "../components/Modal";
import { ErrorNote, Spinner, Toggle, useConfirm } from "../components/common";
import { useToast } from "../components/Toast";
import type { HostedTool } from "../types";

const sampleSchema = { type: "object", properties: { query: { type: "string", description: "Search query" } }, required: ["query"], additionalProperties: false };
const sampleBody = { tool: "{{tool.name}}", arguments: "{{arguments}}", session_id: "{{session.id}}", call_id: "{{call.id}}" };
const json = (value: unknown) => JSON.stringify(value, null, 2);

export function Tools() {
  const { language } = useI18n(), zh = language === "zh";
  const { data, loading, error, reload } = useAsync(() => api.get<{ tools: HostedTool[] }>("/tools"));
  const toast = useToast(), { confirm, confirmEl } = useConfirm();
  const [editing, setEditing] = useState<HostedTool | null | undefined>(undefined);
  const remove = async (tool: HostedTool) => {
    if (!await confirm(zh ? "删除工具" : "Delete tool", zh ? `删除 ${tool.name} 并解除所有服务绑定？` : `Delete ${tool.name} and remove its service bindings?`)) return;
    try { await api.del(`/tools/${tool.id}`); reload(); } catch (e) { toast.error((e as Error).message); }
  };
  return <div>
    <PageHeader title={zh ? "服务器工具" : "Server tools"} icon="bi-tools" subtitle={zh ? "定义工具参数与 HTTP 转发方式，再到 Model Service 或 Micro Agent 中绑定。" : "Define tool parameters and HTTP forwarding, then bind tools to a Model Service or Micro Agent."} action={<button className="btn-primary" onClick={() => setEditing(null)}><i className="bi bi-plus-lg" />{zh ? "注册工具" : "Register tool"}</button>} />
    {loading && <Spinner />}{error && <ErrorNote message={error} />}
    <div className="space-y-3">{data?.tools.map(tool => <article className="card flex items-center justify-between gap-4 p-5" key={tool.id}><div className="min-w-0"><div className="flex items-center gap-3"><h2 className="font-semibold">{tool.name}</h2><span className={tool.enabled ? "text-xs text-brand-400" : "text-xs text-ink-500"}>{tool.enabled ? zh ? "启用" : "Enabled" : zh ? "停用" : "Disabled"}</span></div><p className="mt-1 text-sm text-ink-400">{tool.description}</p><p className="mt-2 truncate font-mono text-xs text-ink-500">POST {tool.url}</p></div><div className="flex shrink-0 gap-2"><button className="btn-secondary" onClick={() => setEditing(tool)}>{zh ? "编辑" : "Edit"}</button><button className="btn-secondary" onClick={() => void remove(tool)}>{zh ? "删除" : "Delete"}</button></div></article>)}</div>
    {data && !data.tools.length && <div className="card p-10 text-center"><i className="bi bi-tools text-3xl text-brand-400" /><h2 className="mt-4 font-semibold">{zh ? "把任意 HTTP API 提供给模型" : "Make an HTTP API available to your model"}</h2><p className="mx-auto mt-2 max-w-xl text-sm text-ink-400">{zh ? "Hydrogen 负责工具循环、会话和结果返回。工具逻辑由你配置的转接服务执行。" : "Hydrogen manages the tool loop, sessions and responses. Your configured adapter implements the tool logic."}</p></div>}
    {editing !== undefined && <ToolEditor tool={editing} onClose={() => setEditing(undefined)} onSaved={reload} />}{confirmEl}
  </div>;
}

function ToolEditor({ tool, onClose, onSaved }: { tool: HostedTool | null; onClose: () => void; onSaved: () => void }) {
  const { language } = useI18n(), zh = language === "zh", toast = useToast();
  const [name, setName] = useState(tool?.name ?? "");
  const [description, setDescription] = useState(tool?.description ?? "");
  const [url, setUrl] = useState(tool?.url ?? "");
  const [schema, setSchema] = useState(json(tool?.parameters ?? sampleSchema));
  const [template, setTemplate] = useState(json(tool?.bodyTemplate ?? sampleBody));
  const [headers, setHeaders] = useState("");
  const [resultPath, setResultPath] = useState(tool?.resultPath ?? "/result");
  const [timeoutMs, setTimeoutMs] = useState(tool?.timeoutMs ?? 30000);
  const [maxResultBytes, setMaxResultBytes] = useState(tool?.maxResultBytes ?? 65536);
  const [enabled, setEnabled] = useState(tool?.enabled ?? true);
  const [argumentsJson, setArgumentsJson] = useState('{"query":"example"}');
  const [resultJson, setResultJson] = useState('{"result":{"answer":"example"}}');
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError("");
    try {
      const value = { name, description, url, parameters: JSON.parse(schema), bodyTemplate: JSON.parse(template), resultPath, timeoutMs, maxResultBytes, enabled,
        ...(headers.trim() ? { headers: JSON.parse(headers) } : tool ? {} : { headers: {} }) };
      if (tool) await api.patch(`/tools/${tool.id}`, value); else await api.post("/tools", value);
      toast.success(zh ? "工具已保存" : "Tool saved"); onSaved(); onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const tryPreview = async () => {
    setError(""); setBusy(true);
    try { setPreview(json(await api.post("/tools/preview", { toolName: name || "example", bodyTemplate: JSON.parse(template), arguments: JSON.parse(argumentsJson), result: JSON.parse(resultJson), resultPath }))); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const area = (label: string, value: string, change: (v: string) => void, rows = 6) => <label className="block"><span className="label">{label}</span><textarea className="input w-full font-mono text-xs" rows={rows} value={value} onChange={e => change(e.target.value)} spellCheck={false} /></label>;
  return <Modal open title={tool ? zh ? `编辑 ${tool.name}` : `Edit ${tool.name}` : zh ? "注册服务器工具" : "Register server tool"} onClose={onClose} size="xl">
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2"><label><span className="label">{zh ? "工具名称" : "Tool name"}</span><input className="input" value={name} maxLength={64} placeholder="search_documents" onChange={e => setName(e.target.value)} /></label><label><span className="label">{zh ? "描述（提供给模型）" : "Description (shown to the model)"}</span><input className="input" value={description} onChange={e => setDescription(e.target.value)} /></label></div>
      <label className="block"><span className="label">POST URL</span><input className="input w-full font-mono" type="url" placeholder="https://adapter.example.com/tools/call" value={url} onChange={e => setUrl(e.target.value)} /></label>
      <label className="block"><span className="label">{zh ? "认证与请求头（JSON）" : "Authentication and headers (JSON)"}</span><input className="input w-full font-mono" type="password" autoComplete="new-password" placeholder={'{"Authorization":"Bearer …"}'} value={headers} onChange={e => setHeaders(e.target.value)} /><p className="mt-1 text-xs text-ink-500">{zh ? "留空保留已保存的头；输入 {} 清空。认证头加密保存。" : "Leave blank to keep saved headers; enter {} to clear. Headers are stored encrypted."}{tool?.headerNames.length ? ` ${tool.headerNames.join(", ")}` : ""}</p></label>
      <div className="grid gap-4 lg:grid-cols-2">{area(zh ? "工具参数 JSON Schema（draft 7）" : "Parameter JSON Schema (draft 7)", schema, setSchema, 10)}{area(zh ? "POST JSON 请求模板" : "POST JSON request template", template, setTemplate, 10)}</div>
      <p className="rounded-lg bg-ink-800 p-3 text-xs leading-relaxed text-ink-300">{zh ? "可引用 {{arguments}}、{{arguments.query}}、{{tool.name}}、{{session.id}} 和 {{call.id}}。完整占位符保留 JSON 类型；嵌入字符串只接受标量。" : "Use {{arguments}}, {{arguments.query}}, {{tool.name}}, {{session.id}} and {{call.id}}. Whole placeholders preserve JSON types; string interpolation accepts scalars."}</p>
      <div className="grid gap-4 sm:grid-cols-3"><label><span className="label">{zh ? "结果 JSON Pointer" : "Result JSON Pointer"}</span><input className="input" placeholder="/result" value={resultPath} onChange={e => setResultPath(e.target.value)} /><p className="mt-1 text-xs text-ink-500">{zh ? "留空返回完整 JSON" : "Empty returns the full JSON"}</p></label><label><span className="label">{zh ? "超时（毫秒）" : "Timeout (ms)"}</span><input className="input" type="number" min={100} max={600000} value={timeoutMs} onChange={e => setTimeoutMs(Number(e.target.value))} /></label><label><span className="label">{zh ? "最大响应字节" : "Maximum response bytes"}</span><input className="input" type="number" min={1} max={1048576} value={maxResultBytes} onChange={e => setMaxResultBytes(Number(e.target.value))} /></label></div>
      <details className="rounded-lg border border-ink-700 p-4"><summary className="cursor-pointer text-sm font-medium">{zh ? "预览参数映射（不会发送 HTTP 请求）" : "Preview mapping (no HTTP request is sent)"}</summary><div className="mt-4 space-y-3"><div className="grid gap-4 sm:grid-cols-2">{area(zh ? "示例工具参数" : "Sample tool arguments", argumentsJson, setArgumentsJson, 3)}{area(zh ? "示例 API 响应" : "Sample API response", resultJson, setResultJson, 3)}</div><button className="btn-secondary" disabled={busy} onClick={() => void tryPreview()}>{zh ? "预览" : "Preview"}</button>{preview && <pre className="overflow-auto rounded bg-ink-950 p-3 text-xs">{preview}</pre>}</div></details>
      <Toggle checked={enabled} onChange={setEnabled} label={zh ? "启用工具" : "Enable tool"} />
      {error && <ErrorNote message={error} />}<div className="flex justify-end gap-3"><button className="btn-secondary" onClick={onClose}>{zh ? "取消" : "Cancel"}</button><button className="btn-primary" disabled={busy} onClick={() => void save()}>{zh ? "保存工具" : "Save tool"}</button></div>
    </div>
  </Modal>;
}
