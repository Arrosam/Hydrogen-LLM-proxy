// Disposable browser fixture: never imports server startup or sends network API calls.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider, useAuth } from "../../src/auth";
import { I18nProvider } from "../../src/lib/i18n";
import { ToastProvider } from "../../src/components/Toast";
import { ServiceEditor } from "../../src/components/ServiceEditor";
import { HostedToolBinding } from "../../src/components/HostedToolBinding";
import { Modal } from "../../src/components/Modal";
import type { HostedTool, ModelService, Model, Provider, Mapping } from "../../src/types";
import "../../src/index.css";

const params = new URLSearchParams(location.search);
localStorage.setItem("hydrogen-language", params.get("lang") ?? "en");
const names = ["search_documents", "lookup_customer", "summarize_report", "check_inventory", "translate_text", "get_weather", "create_draft", "disabled_archive"];
const tools: HostedTool[] = Array.from({ length: Number(params.get("count") ?? 18) }, (_, i) => ({
  id: i + 1, name: names[i] ?? (i === 8 ? "long_registered_tool_name_for_monthly_department_inventory_reports" : `catalog_tool_${String(i + 1).padStart(2, "0")}`),
  description: i === 0 ? "Search internal documents by keyword" : i === 1 ? "Find a customer record by reference" : i === 8 ? "A long description to verify wrapping inside a narrow dropdown without pushing controls beyond the viewport." : "Synthetic catalog option for local interface validation",
  parameters: {}, url: "http://127.0.0.1:1/never-called", bodyTemplate: {}, resultPath: "", timeoutMs: 5000, maxResultBytes: 1024, enabled: i !== 7, headerNames: [], hasHeaders: false,
}));
const service: ModelService = { id: 1, name: "synthetic-chat", description: "Local UI acceptance fixture", enabled: true, summary: "", createdAt: 0,
  toolIds: params.has("cap") ? Array.from({ length: Number(params.get("cap")) }, (_, i) => i + 1) : params.has("missing") ? [8, 999] : [1, 2],
  steps: { timeoutMs: 60000, steps: [{ model: "fixture-model", provider: "local-fixture" }] },
};
const models: Model[] = [{ id: 1, name: "fixture-model", description: null, enabled: true, createdAt: 0 }];
const providers: Provider[] = [{ id: 1, name: "local-fixture", type: "openai_completion", baseUrl: "http://127.0.0.1:1/never-called", hasKey: false, extraHeaders: null, maxOutputTokens: null, enabled: true, createdAt: 0 }];
const mappings: Mapping[] = [{ id: 1, modelId: 1, providerId: 1, upstreamModel: "synthetic", priority: 0, enabled: true }];
let saved: unknown;
window.fetch = async (input, init) => {
  const url = String(input);
  let data: unknown;
  if (url === "/admin/api/me") data = { user: { id: 1, username: "fixture-admin", role: "admin", enabled: true } };
  else if (url === "/admin/api/settings/ui-language") data = { language: params.get("lang") ?? "en" };
  else if (url === "/admin/api/tools") data = { tools };
  else if (url === "/admin/api/services/1" && init?.method === "PATCH") { saved = JSON.parse(String(init.body)); data = {}; }
  else throw new Error(`Fixture blocked unexpected request: ${url}`);
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
};
function Fixture() {
  const { loading } = useAuth();
  const [open, setOpen] = useState(true);
  if (loading) return <p>Loading local fixture…</p>;
  if (params.has("disabled")) return <Modal open title="Disabled hosted tools fixture" onClose={() => {}} size="xl"><HostedToolBinding tools={tools} ids={service.toolIds ?? []} config={{ streamMode: "progress", maxRounds: 8, maxCalls: 16 }} onIds={() => { throw new Error("Disabled fixture changed IDs"); }} onConfig={() => { throw new Error("Disabled fixture changed config"); }} disabled /></Modal>;
  return <><ServiceEditor open={open} service={service} services={[service]} models={models} providers={providers} mappings={mappings} onSaved={() => {}} onClose={() => setOpen(false)} />{!open && <><button onClick={() => setOpen(true)}>Reopen fixture</button><pre aria-label="Saved fixture payload">{JSON.stringify(saved, null, 2)}</pre></>}</>;
}
createRoot(document.getElementById("root")!).render(<I18nProvider><AuthProvider><ToastProvider><Fixture /></ToastProvider></AuthProvider></I18nProvider>);
