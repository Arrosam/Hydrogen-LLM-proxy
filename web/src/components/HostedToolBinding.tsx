import { forwardRef, useId, useMemo, useRef, useState, type HTMLAttributes } from "react";
import { Combobox, ComboboxButton, ComboboxInput, ComboboxOption, ComboboxOptions, Description, Field, Label } from "@headlessui/react";
import type { HostedTool, HostedToolOptions } from "../types";
import { useI18n } from "../lib/i18n";

// Mirrors serviceRoutes' binding limit. Keep additions atomic; never truncate IDs.
const MAX_BINDINGS = 64;

// Keep virtual mode active even with zero results so a stale active option cannot
// be selected with Enter. Render the empty state in the library's options root.
const ToolOptions = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { empty: boolean; emptyLabel: string }>(
  function ToolOptions({ empty, emptyLabel, children, ...props }, ref) {
    return <div {...props} ref={ref}>{empty ? <p className="px-3 py-2 text-sm text-ink-400" role="status">{emptyLabel}</p> : children}</div>;
  },
);

export function HostedToolBinding({ tools, ids, config, onIds, onConfig, disabled = false }: { tools: HostedTool[]; ids: number[]; config: HostedToolOptions; onIds: (ids: number[]) => void; onConfig: (config: HostedToolOptions) => void; disabled?: boolean }) {
  const { language } = useI18n(), zh = language === "zh";
  const [query, setQuery] = useState("");
  const [rejected, setRejected] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const controlId = useId();
  const catalog = useMemo(() => new Map(tools.map(tool => [tool.id, tool])), [tools]);
  const selected = useMemo(() => [...new Set(ids)], [ids]);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return [...catalog.values()].filter(tool => `${tool.name} ${tool.description ?? ""}`.toLocaleLowerCase().includes(term)).map(tool => tool.id);
  }, [catalog, query]);
  const error = zh ? "最多绑定 64 个工具。此次选择未添加任何工具；请先移除一些工具。" : "You can bind up to 64 tools. No tools were added; remove a tool before adding more.";
  const changeSelection = (next: number[]) => {
    if (disabled) return;
    const unique = [...new Set(next)];
    // A catalog refresh may briefly leave an old virtual option mounted.
    // Preserve existing missing bindings, but never add an unavailable ID.
    if (unique.some(id => !catalog.has(id) && !selected.includes(id))) {
      input.current?.focus({ preventScroll: true });
      return;
    }
    // An existing invalid/legacy selection may still be reduced one chip at a time.
    if (unique.length > MAX_BINDINGS && unique.some(id => !selected.includes(id))) {
      setRejected(true);
      // A flipped popup can obscure the inline error above the input. Close it
      // through the library's button while retaining the query and selection.
      if (button.current?.getAttribute("aria-expanded") === "true") button.current.click();
      return;
    } else {
      onIds(unique);
      setRejected(false);
      setQuery("");
    }
    input.current?.focus({ preventScroll: true });
  };
  return <fieldset disabled={disabled} className="space-y-3 rounded-lg border border-ink-700 p-4 disabled:opacity-60">
    <legend className="px-2 text-sm font-semibold">{zh ? "服务器托管工具" : "Hosted server tools"}</legend>
    <p className="text-xs text-ink-400">{zh ? "绑定仅表示工具可用。客户端必须声明每个服务器工具，Hydrogen 才会将其提供给模型或执行。Hydrogen 将已声明工具的参数转发到工具 API，并保存续接上下文。" : "Bindings describe tool availability. Clients must declare each server tool before Hydrogen can offer or execute it. Hydrogen forwards declared tool arguments to the tool API and saves continuation context."}</p>
    <Field disabled={disabled}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <Label className="label mb-0" htmlFor={controlId}>{zh ? "已绑定工具" : "Bound tools"}</Label>
        <span className="text-xs text-ink-400" aria-live="polite">{selected.length} / {MAX_BINDINGS} {zh ? "已选择" : "selected"}</span>
      </div>
      <div className="mb-2 flex flex-wrap gap-2">
        <button type="button" className="btn-ghost btn-xs" disabled={disabled || !filtered.length} onClick={() => changeSelection([...selected, ...filtered])}>{zh ? "选择全部搜索结果" : "Select all search results"}</button>
        <button type="button" className="btn-ghost btn-xs" disabled={disabled || !selected.length} onClick={() => changeSelection([])}>{zh ? "清空" : "Clear"}</button>
      </div>
      <Combobox multiple immediate value={selected} onChange={changeSelection} disabled={disabled} invalid={rejected}
        virtual={{ options: filtered, disabled: id => !catalog.has(id) }}>
        {({ open }) => <>
          <div className={`rounded-lg border bg-ink-950/60 p-2 text-sm text-ink-100 focus-within:ring-1 ${rejected ? "border-red-500 focus-within:ring-red-500" : "border-ink-700 focus-within:border-brand-600 focus-within:ring-brand-600"} ${disabled ? "cursor-not-allowed" : "cursor-text"}`}
            onClick={event => { if (!disabled && event.target === event.currentTarget) input.current?.focus(); }}>
            {rejected && <Description id={`${controlId}-error`} role="alert" className="mb-2 rounded-md bg-red-950/40 px-2 py-1.5 text-xs text-red-300">{error}</Description>}
            {selected.length > 0 && <div className="mb-1 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto p-0.5" aria-label={zh ? "已选择的工具" : "Selected tools"}>
              {selected.map(id => {
                const tool = catalog.get(id);
                const name = tool?.name ?? `${zh ? "未找到工具" : "Missing tool"} #${id}`;
                return <span key={id} className="inline-flex max-w-full items-center gap-1 rounded-md border border-ink-700 bg-ink-800 py-0.5 pl-2 pr-1 text-xs text-ink-200">
                  <span className="min-w-0 break-all">{name}{tool && !tool.enabled && <span className="text-ink-400"> ({zh ? "停用" : "disabled"})</span>}</span>
                  <button type="button" disabled={disabled} aria-label={zh ? `移除 ${name}` : `Remove ${name}`} className="shrink-0 rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100 focus:outline-none focus:ring-2 focus:ring-brand-500/50 disabled:cursor-not-allowed"
                    onClick={() => changeSelection(selected.filter(value => value !== id))}><i className="bi bi-x" aria-hidden="true" /></button>
                </span>;
              })}
            </div>}
            <div className="relative">
              <ComboboxInput id={controlId} ref={input} className="w-full border-0 bg-transparent py-1 pl-1 pr-8 text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none disabled:cursor-not-allowed"
                autoComplete="off" placeholder={zh ? "搜索工具名称或描述…" : "Search tools by name or description…"} value={query}
                aria-invalid={rejected}
                onChange={event => setQuery(event.target.value)} onClick={() => { if (!open) button.current?.click(); }} />
              <ComboboxButton ref={button} className="absolute inset-y-0 right-0 rounded px-2 text-ink-400 hover:text-ink-100 disabled:cursor-not-allowed" aria-label={zh ? "显示工具" : "Show tools"}><i className="bi bi-chevron-down text-xs" aria-hidden="true" /></ComboboxButton>
            </div>
          </div>
          <ComboboxOptions as={ToolOptions} empty={!filtered.length} emptyLabel={zh ? "没有匹配的工具" : "No matching tools"} anchor={{ to: "bottom start", gap: 6, padding: 12 }} modal={false}
            className="z-50 w-[var(--input-width)] overflow-y-auto overscroll-contain rounded-lg border border-ink-700 bg-ink-850 py-1 shadow-xl shadow-black/40 [--anchor-max-height:15rem] focus:outline-none">
            {({ option: id }: { option: number }) => {
              const tool = catalog.get(id);
              const name = tool?.name ?? `${zh ? "未找到工具" : "Missing tool"} #${id}`;
              return <ComboboxOption key={id} value={id} disabled={!tool} className="flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-sm text-ink-200 data-[focus]:bg-ink-700 data-[selected]:text-brand-400 data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-500">
                {({ selected: active }) => <><i className={`bi bi-check2 mt-0.5 shrink-0 ${active ? "visible" : "invisible"}`} aria-hidden="true" /><div className="min-w-0 flex-1"><div className="break-all font-medium">{name}{tool && !tool.enabled && <span className="ml-2 text-xs font-normal text-ink-400">({zh ? "停用" : "disabled"})</span>}</div>{tool?.description && <p className="mt-0.5 break-words text-xs text-ink-400">{tool.description}</p>}</div></>}
              </ComboboxOption>;
            }}
          </ComboboxOptions>
        </>}
      </Combobox>
      <Description id={`${controlId}-help`} className="mt-2 text-xs text-ink-400">{zh ? "最多 64 个工具。选择全部会保留已选项。停用的工具仍可绑定，启用后才会执行。" : "Up to 64 tools. Select all keeps your current selection. Disabled tools stay bound and run only when enabled."}</Description>
      {!catalog.size && <a className="mt-2 inline-block text-sm text-brand-400" href="/tools">{zh ? "前往工具页面注册工具" : "Register a tool on the Tools page"}</a>}
    </Field>
    <label className="block"><span className="label">{zh ? "流式呈现" : "Streaming delivery"}</span><select className="select" value={config.streamMode} onChange={e => onConfig({ ...config, streamMode: e.target.value as HostedToolOptions["streamMode"] })}>
      <option value="all">{zh ? "完整过程：各轮模型内容与工具事件" : "Full process: model rounds and tool events"}</option>
      <option value="progress">{zh ? "工具进度与最终答案" : "Tool progress and final answer"}</option>
      <option value="final">{zh ? "仅流式返回最终答案" : "Stream final answer only"}</option>
    </select></label>
    <p className="text-xs text-ink-500">{zh ? "过程使用 Hydrogen SSE 扩展；最终答案使用客户端原有协议。Micro Agent 的阶段仍按既有的缓冲与路由规则执行。" : "Process events use Hydrogen SSE extensions; the final answer uses the client protocol. Micro Agent stages retain their existing buffering and routing rules."}</p>
    <div className="grid grid-cols-2 gap-3"><label><span className="label">{zh ? "最大模型轮数" : "Maximum model rounds"}</span><input type="number" className="input" min={1} max={32} value={config.maxRounds} onChange={e => onConfig({ ...config, maxRounds: Number(e.target.value) })} /></label><label><span className="label">{zh ? "最大工具调用数" : "Maximum tool calls"}</span><input type="number" className="input" min={1} max={128} value={config.maxCalls} onChange={e => onConfig({ ...config, maxCalls: Number(e.target.value) })} /></label></div>
  </fieldset>;
}
