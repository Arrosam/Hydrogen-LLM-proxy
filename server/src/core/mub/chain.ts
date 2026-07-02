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
import { runMubJson, runMubStream, type JsonSuccess, type StreamSuccess } from "../proxy/run";
import type { AttemptFailure, AttemptRecord } from "./engine";
import type { ChainDef, ChainPart, ChainStage } from "./schema";

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

function outputStageName(chain: ChainDef): string {
  return chain.output ?? chain.stages[chain.stages.length - 1].name;
}

function stageSteps(chain: ChainDef, stage: ChainStage): { timeoutMs: number; steps: ChainStage["steps"] } {
  return { timeoutMs: stage.timeoutMs ?? chain.timeoutMs, steps: stage.steps };
}

export interface ChainRunResult {
  result: { ok: true; value: JsonSuccess } | AttemptFailure;
  path: AttemptRecord[];
  usage: IRUsage;
}

/**
 * Run a chain to completion (non-streaming). Stages run in order, each stage's
 * output feeding later stages; execution stops at the `output` stage, whose
 * response (carrying the summed usage across stages) is returned.
 */
export async function runMubChain(ir: IRRequest, chain: ChainDef): Promise<ChainRunResult> {
  const outputs: Record<string, string> = {};
  const path: AttemptRecord[] = [];
  let usage = ZERO_USAGE;
  const outStage = outputStageName(chain);

  for (const stage of chain.stages) {
    const stageIR = buildStageIR(ir, stage, outputs, false);
    const { result, path: stagePath } = await runMubJson(stageIR, stageSteps(chain, stage));
    for (const rec of stagePath) path.push({ ...rec, stage: stage.name });
    if (!result.ok) return { result, path, usage };
    outputs[stage.name] = textOf(result.value.ir.content);
    usage = addUsage(usage, result.value.ir.usage);
    if (stage.name === outStage) {
      const value: JsonSuccess = { ...result.value, ir: { ...result.value.ir, usage } };
      return { result: { ok: true, value }, path, usage };
    }
  }
  return {
    result: { ok: false, status: 0, kind: "error", message: `chain output stage "${outStage}" not found` },
    path,
    usage,
  };
}

export interface ChainStreamResult {
  result: { ok: true; value: StreamSuccess } | AttemptFailure;
  path: AttemptRecord[];
  priorUsage: IRUsage;
}

/**
 * Run a chain where the client asked to stream: every stage before the `output`
 * stage runs buffered (JSON), then the output stage is streamed to the client.
 * `priorUsage` (the summed usage of the buffered stages) is returned so the
 * caller can add it to the streamed stage's usage for logging/accounting.
 */
export async function runMubChainStream(ir: IRRequest, chain: ChainDef): Promise<ChainStreamResult> {
  const outputs: Record<string, string> = {};
  const path: AttemptRecord[] = [];
  let priorUsage = ZERO_USAGE;
  const outStage = outputStageName(chain);

  for (const stage of chain.stages) {
    if (stage.name === outStage) {
      const stageIR = buildStageIR(ir, stage, outputs, true);
      const { result, path: stagePath } = await runMubStream(stageIR, stageSteps(chain, stage));
      for (const rec of stagePath) path.push({ ...rec, stage: stage.name });
      return { result, path, priorUsage };
    }
    const stageIR = buildStageIR(ir, stage, outputs, false);
    const { result, path: stagePath } = await runMubJson(stageIR, stageSteps(chain, stage));
    for (const rec of stagePath) path.push({ ...rec, stage: stage.name });
    if (!result.ok) return { result, path, priorUsage };
    outputs[stage.name] = textOf(result.value.ir.content);
    priorUsage = addUsage(priorUsage, result.value.ir.usage);
  }
  return {
    result: { ok: false, status: 0, kind: "error", message: `chain output stage "${outStage}" not found` },
    path,
    priorUsage,
  };
}
