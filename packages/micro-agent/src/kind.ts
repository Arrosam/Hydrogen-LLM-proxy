import { registerServiceKind, type ServiceKindHandler } from "@areelai/model-services";
import { MICRO_AGENT_ALIASES, MICRO_AGENT_KIND, agentReferences, parseAgent, summarizeAgent, type AgentDef } from "./definition.js";
import { validateAgent } from "./validate.js";
import { MicroAgent } from "./microAgent.js";
import type { OcrCacheStore } from "./ocrCache.js";

export interface MicroAgentKindOptions {
  /** Image-description cache for the OCR pre-pass; omitted = every image goes to the model. */
  ocrCache?: OcrCacheStore | null;
}

/** The handler that teaches model-services how to parse, validate and run a Micro Agent. */
export function microAgentKind(opts: MicroAgentKindOptions = {}): ServiceKindHandler<AgentDef> {
  return {
    kind: MICRO_AGENT_KIND,
    aliases: MICRO_AGENT_ALIASES,
    parse: parseAgent,
    category: () => "chat",
    summarize: summarizeAgent,
    references: agentReferences,
    validate: validateAgent,
    build: (def, ctx) =>
      new MicroAgent(def, { ...ctx.deps, resolver: ctx.resolver, logMaxChars: ctx.logMaxChars, ocrCache: opts.ocrCache ?? null }),
  };
}

/**
 * Register the Micro Agent kind with model-services. Call once at startup,
 * before any definition of kind "micro_agent" is parsed; until then such a
 * row is rejected as an unknown service kind.
 */
export function registerMicroAgentKind(opts: MicroAgentKindOptions = {}): void {
  registerServiceKind(microAgentKind(opts));
}
