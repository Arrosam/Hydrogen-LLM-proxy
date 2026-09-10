import type { HostedTool, HostedToolOptions } from "../types";
import { useI18n } from "../lib/i18n";

export function HostedToolBinding({ tools, ids, config, onIds, onConfig }: { tools: HostedTool[]; ids: number[]; config: HostedToolOptions; onIds: (ids: number[]) => void; onConfig: (config: HostedToolOptions) => void }) {
  const { language } = useI18n(), zh = language === "zh";
  return <fieldset className="space-y-3 rounded-lg border border-ink-700 p-4">
    <legend className="px-2 text-sm font-semibold">{zh ? "服务器托管工具" : "Hosted server tools"}</legend>
    <p className="text-xs text-ink-400">{zh ? "绑定后自动向模型提供工具。Hydrogen 将参数转发至工具 API，并保存续接上下文。" : "Bound tools are supplied automatically. Hydrogen forwards arguments to the tool API and saves continuation context."}</p>
    {tools.length ? <div className="flex flex-wrap gap-3">{tools.map(tool => <label key={tool.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ids.includes(tool.id)} onChange={e => onIds(e.target.checked ? [...ids, tool.id] : ids.filter(id => id !== tool.id))} />{tool.name}{!tool.enabled && <span className="text-ink-500">({zh ? "停用" : "disabled"})</span>}</label>)}</div> : <a className="text-sm text-brand-400" href="/tools">{zh ? "前往工具页面注册工具" : "Register a tool on the Tools page"}</a>}
    <label className="block"><span className="label">{zh ? "流式呈现" : "Streaming delivery"}</span><select className="select" value={config.streamMode} onChange={e => onConfig({ ...config, streamMode: e.target.value as HostedToolOptions["streamMode"] })}>
      <option value="all">{zh ? "完整过程：各轮模型内容与工具事件" : "Full process: model rounds and tool events"}</option>
      <option value="progress">{zh ? "工具进度与最终答案" : "Tool progress and final answer"}</option>
      <option value="final">{zh ? "仅流式返回最终答案" : "Stream final answer only"}</option>
    </select></label>
    <p className="text-xs text-ink-500">{zh ? "过程使用 Hydrogen SSE 扩展；最终答案使用客户端原有协议。Micro Agent 的阶段仍按既有的缓冲与路由规则执行。" : "Process events use Hydrogen SSE extensions; the final answer uses the client protocol. Micro Agent stages retain their existing buffering and routing rules."}</p>
    <div className="grid grid-cols-2 gap-3"><label><span className="label">{zh ? "最大模型轮数" : "Maximum model rounds"}</span><input type="number" className="input" min={1} max={32} value={config.maxRounds} onChange={e => onConfig({ ...config, maxRounds: Number(e.target.value) })} /></label><label><span className="label">{zh ? "最大工具调用数" : "Maximum tool calls"}</span><input type="number" className="input" min={1} max={128} value={config.maxCalls} onChange={e => onConfig({ ...config, maxCalls: Number(e.target.value) })} /></label></div>
  </fieldset>;
}
