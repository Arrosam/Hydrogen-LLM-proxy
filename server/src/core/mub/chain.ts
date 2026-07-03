import { normalizeMessages, textOf, type IRMessage, type IRRequest, type IRUsage } from "../ir";
import { genId } from "../../util/ids";
import { runMubJson, type JsonSuccess } from "../proxy/run";
import type { AttemptFailure, AttemptRecord } from "./engine";
import type { ChainCondition, ChainDef, ChainStage, MubSteps } from "./schema";

const ZERO_USAGE: IRUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function addUsage(a: IRUsage, b: IRUsage): IRUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** Concatenated text of the original user messages (used only as a fallback). */
function originalUserText(ir: IRRequest): string {
  let text = "";
  for (const m of ir.messages) {
    if (m.role !== "user") continue;
    for (const p of m.content) if (p.type === "text") text += (text ? "\n" : "") + p.text;
  }
  return text;
}

/** Assemble a stage's context blocks into IR messages. */
function buildStageMessages(
  stage: ChainStage,
  ir: IRRequest,
  outputs: Record<string, string>,
): IRMessage[] {
  if (stage.input.length === 0) {
    return ir.messages.map((m) => ({ role: m.role, content: [...m.content] }));
  }
  const lastUser = [...ir.messages].reverse().find((m) => m.role === "user");
  const out: IRMessage[] = [];
  for (const block of stage.input) {
    switch (block.kind) {
      case "original_conversation":
        for (const m of ir.messages) out.push({ role: m.role, content: [...m.content] });
        break;
      case "text_conversation":
        for (const m of ir.messages) {
          const content = m.content.filter((p) => p.type !== "image");
          if (content.length) out.push({ role: m.role, content: [...content] });
        }
        break;
      case "last_user":
        if (lastUser) out.push({ role: "user", content: [...lastUser.content] });
        break;
      case "stage_output": {
        const text = outputs[block.stage] ?? "";
        if (text) out.push({ role: block.role, content: [{ type: "text", text }] });
        break;
      }
      case "message":
        if (block.text) out.push({ role: block.role, content: [{ type: "text", text: block.text }] });
        break;
      case "tool_turn": {
        const id = block.id || genId("toolu");
        let input: unknown = {};
        try {
          input = block.input ? JSON.parse(block.input) : {};
        } catch {
          input = {};
        }
        out.push({ role: "assistant", content: [{ type: "tool_use", id, name: block.name, input }] });
        out.push({
          role: "user",
          content: [{ type: "tool_result", toolUseId: id, content: [{ type: "text", text: block.result }], isError: block.isError }],
        });
        break;
      }
    }
  }
  return out;
}

/** Assemble the IRRequest sent to a single chain stage. */
export function buildStageIR(
  ir: IRRequest,
  stage: ChainStage,
  outputs: Record<string, string>,
  stream: boolean,
): IRRequest {
  let messages = normalizeMessages(buildStageMessages(stage, ir, outputs));
  if (messages.length === 0) {
    messages = [{ role: "user", content: [{ type: "text", text: originalUserText(ir) }] }];
  }

  return {
    requestedModel: ir.requestedModel,
    system: stage.system && stage.system.trim() ? stage.system : ir.system,
    messages,
    tools: ir.tools,
    toolChoice: ir.toolChoice,
    maxTokens: stage.maxTokens ?? ir.maxTokens,
    temperature: stage.temperature ?? ir.temperature,
    topP: ir.topP,
    stop: ir.stop,
    stream,
    extra: ir.extra,
  };
}

// --- resilience-MUB resolution + condition evaluation -----------------------

/**
 * Resolve a stage's referenced resilience MUB name to its steps. Provided by the
 * caller (the proxy) so this module stays free of the DB/service layer.
 */
export type StageResolver = (mubName: string) => { ok: true; steps: MubSteps } | { ok: false; message: string };

function isRouter(stage: ChainStage): boolean {
  return !stage.mub && (!stage.steps || stage.steps.length === 0);
}

/** The resilience steps a stage runs (from its mub ref or inline steps). */
function resolveStageSteps(
  chain: ChainDef,
  stage: ChainStage,
  resolve: StageResolver,
): { ok: true; steps: MubSteps } | { ok: false; message: string } {
  if (stage.mub) {
    const r = resolve(stage.mub);
    if (!r.ok) return r;
    return { ok: true, steps: { timeoutMs: stage.timeoutMs ?? r.steps.timeoutMs, steps: r.steps.steps } };
  }
  if (stage.steps && stage.steps.length) {
    return { ok: true, steps: { timeoutMs: stage.timeoutMs ?? chain.timeoutMs, steps: stage.steps } };
  }
  return { ok: false, message: `stage "${stage.name}" has no MUB or steps` };
}

function safeRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return /(?!)/; // never matches (validation rejects bad regex before this)
  }
}

interface InputCtx {
  text: string; // concatenated original user text
  hasImage: boolean;
}

function inputContext(ir: IRRequest): InputCtx {
  let hasImage = false;
  for (const m of ir.messages) for (const p of m.content) if (p.type === "image") hasImage = true;
  return { text: originalUserText(ir), hasImage };
}

function conditionHolds(
  cond: ChainCondition,
  input: InputCtx,
  outputs: Record<string, string>,
  currentStage: string,
): boolean {
  switch (cond.type) {
    case "always":
      return true;
    case "input_has_image":
      return input.hasImage;
    case "input_contains":
      return input.text.includes(cond.value);
    case "input_matches":
      return safeRegex(cond.value).test(input.text);
    case "output_contains":
      return (outputs[cond.stage ?? currentStage] ?? "").includes(cond.value);
    case "output_matches":
      return safeRegex(cond.value).test(outputs[cond.stage ?? currentStage] ?? "");
  }
}

/** The next stage index to run: first matching forward transition, else fall through. */
function nextStageIndex(
  stage: ChainStage,
  idx: number,
  byName: Map<string, number>,
  input: InputCtx,
  outputs: Record<string, string>,
): number | "end" {
  for (const t of stage.transitions ?? []) {
    if (conditionHolds(t.when, input, outputs, stage.name)) {
      if (t.goto === "end") return "end";
      const j = byName.get(t.goto);
      return j != null && j > idx ? j : "end"; // forward-only (validation enforces)
    }
  }
  return idx + 1; // fall through to the next stage (caller ends if out of range)
}

// --- chain execution --------------------------------------------------------

export interface ChainRunResult {
  result: { ok: true; value: JsonSuccess } | AttemptFailure;
  path: AttemptRecord[];
  usage: IRUsage;
}

/**
 * Run a chain as a forward-only decision tree. Starting at the first stage, run
 * the stage's resilience MUB (buffered), then take the first transition whose
 * condition holds (a later stage or "end"); with no matching transition, fall
 * through to the next stage. Usage is summed across every stage that runs; the
 * response returned is the terminal stage's (or the `output`-named stage's),
 * carrying the summed usage.
 */
export async function runMubChain(
  ir: IRRequest,
  chain: ChainDef,
  resolve: StageResolver,
): Promise<ChainRunResult> {
  const input = inputContext(ir);
  const byName = new Map(chain.stages.map((s, i) => [s.name, i]));
  const outputs: Record<string, string> = {};
  const values: Record<string, JsonSuccess> = {};
  const path: AttemptRecord[] = [];
  let usage = ZERO_USAGE;
  let lastValue: JsonSuccess | null = null;
  let terminal = chain.stages[0]?.name ?? "";

  let idx = 0;
  while (idx >= 0 && idx < chain.stages.length) {
    const stage = chain.stages[idx];
    terminal = stage.name;

    if (isRouter(stage)) {
      outputs[stage.name] = "";
      path.push({ step: 1, attempt: 1, model: "(router)", provider: "-", status: 200, kind: "ok", latencyMs: 0, stage: stage.name });
    } else {
      const steps = resolveStageSteps(chain, stage, resolve);
      if (!steps.ok) return { result: { ok: false, status: 0, kind: "error", message: steps.message }, path, usage };
      const stageIR = buildStageIR(ir, stage, outputs, false);
      const { result, path: stagePath } = await runMubJson(stageIR, steps.steps);
      for (const rec of stagePath) path.push({ ...rec, stage: stage.name });
      if (!result.ok) return { result, path, usage };
      outputs[stage.name] = textOf(result.value.ir.content);
      values[stage.name] = result.value;
      lastValue = result.value;
      usage = addUsage(usage, result.value.ir.usage);
    }

    const next = nextStageIndex(stage, idx, byName, input, outputs);
    if (next === "end") break;
    idx = next;
  }

  const chosen = (chain.output && values[chain.output]) || values[terminal] || lastValue;
  if (!chosen) {
    return { result: { ok: false, status: 0, kind: "error", message: "chain produced no model output" }, path, usage };
  }
  const value: JsonSuccess = { ...chosen, ir: { ...chosen.ir, usage } };
  return { result: { ok: true, value }, path, usage };
}
