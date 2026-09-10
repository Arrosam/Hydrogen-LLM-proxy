import { isChatPipeline, isStepChain, type KindValidationContext, type ServiceCategory } from "@areelai/model-services";
import type { AgentDef } from "./definition.js";

/**
 * Semantic validation of a Micro Agent against the live catalog and service
 * store: duplicate/forward stage references, an unknown output stage, bad
 * pre-pass references, unmapped inline steps. Shape problems are the zod
 * schema's job and never reach here.
 */
export function validateAgent(def: AgentDef, ctx: KindValidationContext): void {
  const names = def.stages.map((s) => s.name);
  const nameSet = new Set(names);
  if (nameSet.size !== names.length) {
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    ctx.fail(`duplicate stage name "${dup}"`);
  }
  const indexByName = new Map(names.map((n, i) => [n, i]));

  for (let i = 0; i < def.stages.length; i++) {
    const stage = def.stages[i];
    const earlier = new Set(names.slice(0, i));
    const bad = (msg: string): never => ctx.fail(`stage "${stage.name}": ${msg}`);

    for (const b of stage.input) {
      if (b.kind === "stage_output" && !earlier.has(b.stage)) {
        bad(`references "${b.stage}", which is not an earlier stage`);
      }
      if (b.kind === "tool_turn" && b.input) {
        try {
          JSON.parse(b.input);
        } catch {
          bad(`tool turn "${b.name}" has invalid JSON arguments`);
        }
      }
    }

    const isRouter = !stage.service && (!stage.steps || stage.steps.length === 0);
    if (stage.service) {
      const ref = ctx.services.getByName(stage.service);
      if (!ref) bad(`references unknown Model Service or Micro Agent "${stage.service}"`);
      else {
        // Media passthrough services (image/video/tts/stt/embedding/rerank)
        // speak a different request shape; a stage cannot run them. Chat
        // and OCR services both run the chat pipeline, so both are fine.
        const cat = ctx.categoryOf(stage.service);
        if (cat && !isChatPipeline(cat as ServiceCategory)) bad(`references "${stage.service}", a ${cat} service — only chat/OCR services can run inside a Micro Agent`);
      }
    } else if (stage.steps && stage.steps.length) {
      for (const s of stage.steps) {
        if (!ctx.catalog.exists(s.model, s.provider)) ctx.invalidPairs.push(`${s.model}@${s.provider}`);
      }
    }

    for (const t of stage.transitions ?? []) {
      if (t.goto !== "end") {
        const j = indexByName.get(t.goto);
        if (j == null) bad(`transition goto "${t.goto}" is not a stage`);
        else if (j <= i) bad(`transition goto "${t.goto}" must be a later stage (forward-only)`);
      } else if (t.output) {
        const j = indexByName.get(t.output);
        if (j == null) bad(`transition returns unknown stage "${t.output}"`);
        else if (j > i) bad(`transition returns later stage "${t.output}" (must be this or an earlier stage)`);
        else {
          const target = def.stages[j];
          const targetIsRouter = !target.service && (!target.steps || target.steps.length === 0);
          if (targetIsRouter) bad(`transition returns router stage "${t.output}", which produces no output`);
        }
      }
      const c = t.when;
      if (c.type === "input_matches" || c.type === "output_matches") {
        // Length-capped: these patterns run synchronously against
        // client-influenced text on the event loop, so a huge pattern is a
        // DoS hazard the compile check below cannot see. agentContext.ts
        // also refuses (never matches) anything longer at run time.
        if (c.value.length > 200) {
          bad(`condition regex is too long (${c.value.length} chars, max 200)`);
        }
        try {
          new RegExp(c.value);
        } catch {
          bad(`invalid regex "${c.value}"`);
        }
      }
      if (c.type === "output_contains" || c.type === "output_matches") {
        if (isRouter) bad("cannot test output -- a router makes no model call");
        const ref = c.stage ?? stage.name;
        const j = indexByName.get(ref);
        if (j == null) bad(`condition references unknown stage "${ref}"`);
        else if (j > i) bad(`condition references later stage "${ref}"`);
      }
    }
  }
  if (def.output && !nameSet.has(def.output)) {
    ctx.fail(`output stage "${def.output}" is not a defined stage`);
  }

  if (def.ocr) {
    const o = def.ocr;
    if (o.service) {
      const m = ctx.services.getByName(o.service);
      if (!m) ctx.fail(`image translation (OCR) references unknown Model Service "${o.service}"`);
      if (!isStepChain(ctx.services.def(m))) {
        ctx.fail(`image translation (OCR) references a Micro Agent "${o.service}" (must be a Model Service)`);
      }
      const cat = ctx.categoryOf(o.service);
      if (cat && !isChatPipeline(cat as ServiceCategory)) {
        ctx.fail(`image translation (OCR) references "${o.service}", a ${cat} service — it must be a chat or OCR Model Service`);
      }
    } else if (o.steps && o.steps.length) {
      for (const s of o.steps) {
        if (!ctx.catalog.exists(s.model, s.provider)) ctx.invalidPairs.push(`${s.model}@${s.provider}`);
      }
    } else {
      ctx.fail("image translation (OCR) is enabled but has no model (pick a Model Service)");
    }
  }

  if (def.asr) {
    const a = def.asr;
    if (a.service) {
      const m = ctx.services.getByName(a.service);
      if (!m) ctx.fail(`audio transcription (ASR) references unknown Model Service "${a.service}"`);
      if (!isStepChain(ctx.services.def(m))) {
        ctx.fail(`audio transcription (ASR) references a Micro Agent "${a.service}" (must be an stt Model Service)`);
      }
      const cat = ctx.categoryOf(a.service);
      if (cat !== "stt") {
        ctx.fail(`audio transcription (ASR) references "${a.service}", a ${cat ?? "chat"} service — it must be an stt (speech-to-text) Model Service`);
      }
    } else if (a.steps && a.steps.length) {
      // Inline ASR steps call /audio/transcriptions directly, so they carry
      // the same OpenAI-endpoint requirement an stt service would.
      for (const st of a.steps) {
        const bad = ctx.requireMediaEndpoint(st.model, st.provider, "audio transcription (ASR) steps");
        if (bad) ctx.invalidPairs.push(bad);
      }
    } else {
      ctx.fail("audio transcription (ASR) is enabled but has no model (pick an stt Model Service)");
    }
  }
}
