import {
  normalizeMessages,
  textOf,
  type IRContentPart,
  type IRImagePart,
  type IRMessage,
  type IRRequest,
  type IRTextPart,
  type IRUsage,
} from "../ir";
import { runMubJson, type JsonSuccess } from "../proxy/run";
import type { AttemptFailure, AttemptRecord } from "./engine";
import type { ChainCondition, ChainDef, ChainPart, ChainStage, MubSteps } from "./schema";

const ZERO_USAGE: IRUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function addUsage(a: IRUsage, b: IRUsage): IRUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

interface OriginalCtx {
  text: string; // concatenated text of the original user messages
  images: IRImagePart[]; // all image parts from the original request
  system?: string;
  messages: IRMessage[];
}

function originalContext(ir: IRRequest): OriginalCtx {
  let text = "";
  const images: IRImagePart[] = [];
  for (const m of ir.messages) {
    for (const p of m.content) {
      if (p.type === "text" && m.role === "user") text += (text ? "\n" : "") + p.text;
      if (p.type === "image") images.push(p);
    }
  }
  return { text, images, system: ir.system, messages: ir.messages };
}

/** Resolve one content part to IR content parts. `original_messages` is handled
 * at the block level (it splices whole messages), so it yields nothing here. */
function partToContent(
  part: ChainPart,
  orig: OriginalCtx,
  outputs: Record<string, string>,
): IRContentPart[] {
  switch (part.source) {
    case "literal":
      return part.text ? [{ type: "text", text: part.text }] : [];
    case "original_text":
      return orig.text ? [{ type: "text", text: orig.text }] : [];
    case "original_system":
      return orig.system ? [{ type: "text", text: orig.system }] : [];
    case "original_images":
      return orig.images.map((im) => ({ ...im }));
    case "stage": {
      const out = outputs[part.name] ?? "";
      return out ? [{ type: "text", text: out }] : [];
    }
    case "original_messages":
      return [];
  }
}

function buildStageMessages(
  stage: ChainStage,
  orig: OriginalCtx,
  outputs: Record<string, string>,
): IRMessage[] {
  if (stage.input.length === 0) {
    return orig.messages.map((m) => ({ role: m.role, content: [...m.content] }));
  }
  const out: IRMessage[] = [];
  for (const block of stage.input) {
    if (block.parts.some((p) => p.source === "original_messages")) {
      for (const m of orig.messages) out.push({ role: m.role, content: [...m.content] });
      continue;
    }
    const content: IRContentPart[] = [];
    for (const part of block.parts) content.push(...partToContent(part, orig, outputs));
    if (content.length) out.push({ role: block.role, content });
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
  const orig = originalContext(ir);
  let messages = normalizeMessages(buildStageMessages(stage, orig, outputs));
  if (messages.length === 0) {
    messages = [{ role: "user", content: [{ type: "text", text: orig.text }] }];
  }

  let system = ir.system;
  if (stage.system) {
    const sysText = stage.system
      .flatMap((p) => partToContent(p, orig, outputs))
      .filter((c): c is IRTextPart => c.type === "text")
      .map((c) => c.text)
      .join("");
    system = sysText || undefined;
  }

  return {
    requestedModel: ir.requestedModel,
    system,
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

function conditionHolds(
  cond: ChainCondition,
  orig: OriginalCtx,
  outputs: Record<string, string>,
  currentStage: string,
): boolean {
  switch (cond.type) {
    case "always":
      return true;
    case "input_has_image":
      return orig.images.length > 0;
    case "input_contains":
      return orig.text.includes(cond.value);
    case "input_matches":
      return safeRegex(cond.value).test(orig.text);
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
  orig: OriginalCtx,
  outputs: Record<string, string>,
): number | "end" {
  for (const t of stage.transitions ?? []) {
    if (conditionHolds(t.when, orig, outputs, stage.name)) {
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
  const orig = originalContext(ir);
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

    const next = nextStageIndex(stage, idx, byName, orig, outputs);
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
