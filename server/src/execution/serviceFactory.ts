import type { ModelServiceRow } from "../db/schema";
import { isAgent, isChatPipeline, parseService, serviceCategory, type ServiceDef } from "./definition";
import { ModelService, type ServiceDeps } from "./modelService";
import { MicroAgent, type MicroAgentDeps, type ResolveResult, type ServiceResolver } from "./microAgent";
import type { OcrCacheStore } from "./ocrCache";
import type { HostedToolRepo } from "../persistence/hostedToolRepo";
import { HostedToolService } from "./hostedToolService";
import type { ServiceSnapshot, SnapshotService } from "./serviceSnapshot";

type ServiceLookup = { getByName(name: string): Pick<ModelServiceRow, "id" | "name" | "enabled" | "definition"> | undefined };
type BoundToolLookup = Pick<HostedToolRepo, "forService">;

/**
 * Builds a runnable executor (ModelService or MicroAgent) from a saved service.
 * It is the concrete {@link ServiceResolver} a Micro Agent uses to resolve a
 * named stage/OCR reference, and it hands itself to every MicroAgent it builds
 * so nested agents resolve recursively.
 */
export class ServiceFactory implements ServiceResolver {
  constructor(
    private readonly services: ServiceLookup,
    private readonly deps: ServiceDeps,
    private readonly logMaxChars: number | (() => number),
    /** Image-description cache for the OCR pre-pass; omitted = no caching. */
    private readonly ocrCache: OcrCacheStore | null = null,
    private readonly hostedTools: BoundToolLookup | null = null,
  ) {}

  /** Capture only session-relevant feature configuration. Upstream catalog,
   * credentials and SSRF checks remain live security boundaries. */
  snapshot(row: Pick<ModelServiceRow, "id" | "name" | "enabled" | "definition">): ServiceSnapshot {
    const services: SnapshotService[] = [];
    const visited = new Set<number>();
    const capture = (current: typeof row): void => {
      if (visited.has(current.id)) return;
      visited.add(current.id);
      services.push({ id: current.id, name: current.name, enabled: current.enabled,
        definition: structuredClone(current.definition), tools: structuredClone(this.hostedTools?.forService(current.id) ?? []) });
      let def: ServiceDef;
      try { def = parseService(current.definition); } catch { return; }
      if (!isAgent(def)) return;
      for (const name of [...def.stages.map(stage => stage.service), def.ocr?.service, def.asr?.service]) {
        const child = name ? this.services.getByName(name) : undefined;
        if (child) capture(child);
      }
    };
    capture(row);
    const prefix = this.deps.serverToolNamePrefix;
    return { version: 1, rootId: row.id, services, serverToolNamePrefix: typeof prefix === "function" ? prefix() : prefix ?? "provider_server_side_" };
  }

  /** Build every nested resolver from the original graph, including definitions
   * and tools subsequently renamed, disabled or removed from operator config. */
  fromSnapshot(snapshot: ServiceSnapshot): { executor: ModelService; isAgent: boolean } {
    if (snapshot.version !== 1) throw new Error("Unsupported service snapshot version");
    const frozen = structuredClone(snapshot);
    const root = frozen.services.find(service => service.id === frozen.rootId);
    if (!root) throw new Error("Service snapshot has no root service");
    const factory = new ServiceFactory(
      { getByName: name => frozen.services.find(service => service.name === name) },
      { ...this.deps, serverToolNamePrefix: frozen.serverToolNamePrefix },
      this.logMaxChars, this.ocrCache,
      { forService: id => frozen.services.find(service => service.id === id)?.tools ?? [] },
    );
    return factory.buildDef(parseService(root.definition));
  }

  private microDeps(): MicroAgentDeps {
    return { ...this.deps, resolver: this, logMaxChars: this.logMaxChars, ocrCache: this.ocrCache };
  }

  /** Build an executor from an already-parsed definition (e.g. an ad-hoc dry-run). */
  buildDef(def: ServiceDef): { executor: ModelService; isAgent: boolean } {
    return isAgent(def)
      ? { executor: new MicroAgent(def, this.microDeps()), isAgent: true }
      : { executor: new ModelService(def, this.deps), isAgent: false };
  }

  /** Build the top-level executor for a saved service. Throws ZodError on a bad definition. */
  forRow(row: ModelServiceRow): { executor: ModelService; isAgent: boolean } {
    return this.buildDef(parseService(row.definition));
  }

  /** Include nested stage bindings when choosing the stateful Anthropic route. */
  hasHostedTools(row: Pick<ModelServiceRow, "id" | "name" | "enabled" | "definition">, visited = new Set<number>()): boolean {
    if (visited.has(row.id) || !row.enabled) return false;
    visited.add(row.id);
    if (this.hostedTools?.forService(row.id).length) return true;
    let def: ServiceDef;
    try { def = parseService(row.definition); } catch { return false; }
    if (!isAgent(def)) return false;
    const names = [...def.stages.map(stage => stage.service), def.ocr?.service];
    return names.some(name => {
      const child = name ? this.services.getByName(name) : undefined;
      return child ? this.hasHostedTools(child, visited) : false;
    });
  }

  /** Resolve an stt-category Model Service to its raw step chain (the ASR
   * pre-pass drives the transcriptions endpoint itself; there is no chat
   * executor to build). */
  sttDef(name: string): { ok: true; def: import("./definition").ServiceSteps } | { ok: false; message: string } {
    const row = this.services.getByName(name);
    if (!row || !row.enabled) {
      return { ok: false, message: `audio transcription (ASR) references unknown or disabled Model Service "${name}"` };
    }
    try {
      const def = parseService(row.definition);
      if (isAgent(def)) return { ok: false, message: `audio transcription (ASR) references a Micro Agent "${name}" (must be an stt Model Service)` };
      if (serviceCategory(def) !== "stt") {
        return { ok: false, message: `audio transcription (ASR) references "${name}", a ${serviceCategory(def)} service — it must be an stt (speech-to-text) Model Service` };
      }
      return { ok: true, def };
    } catch {
      return { ok: false, message: `"${name}" has an invalid definition` };
    }
  }

  resolve(name: string): ResolveResult {
    const row = this.services.getByName(name);
    if (!row || !row.enabled) {
      return { ok: false, message: `references unknown or disabled Model Service or Micro Agent "${name}"` };
    }
    try {
      const def = parseService(row.definition);
      // The save-time validator rejects this too, but the referenced service
      // can change category after the agent was saved — re-check at runtime.
      const category = serviceCategory(def);
      if (!isChatPipeline(category)) {
        return { ok: false, message: `"${name}" is a ${category} service and cannot run inside a Micro Agent` };
      }
      const { executor, isAgent: agent } = this.buildDef(def);
      const tools = this.hostedTools?.forService(row.id) ?? [];
      return { ok: true, executor: tools.length ? new HostedToolService(executor, this.deps, tools, def.hostedTools) : executor, isAgent: agent };
    } catch {
      return { ok: false, message: `"${name}" has an invalid definition` };
    }
  }
}
