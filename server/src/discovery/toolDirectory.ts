import { createHmac, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ErrorCode, McpError, type ListToolsResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { isAgent, isChatPipeline, parseService, serviceCategory, type ServiceDef, type ServiceSteps } from "../execution/definition";
import { DEFAULT_SERVER_TOOL_POLICY } from "../execution/serverTools";
import type { ModelServiceRow } from "../db/schema";
import type { HostedToolDefinition } from "../persistence/hostedToolRepo";
import { toolValidator } from "../execution/toolSchema";

export const DISCOVERY_PAGE_SIZE = 100;
export const DISCOVERY_META = "hydrogen/discovery";
const MAX_NESTING = 8;
const ENTRY_NOTICE = "Discovery only: tools/call is unsupported at this endpoint.";

interface DirectorySources {
  services: { getByName(name: string): ModelServiceRow | undefined };
  tools: { definitionsForService(id: number): HostedToolDefinition[] };
}
interface Entry { definition: Tool; identity: string; }

function configurationError(reason = "invalid_configuration"): never {
  throw new McpError(ErrorCode.InternalError, "Tool discovery configuration is invalid.", { reason });
}

/** Pure configuration reads only. No executor, inference request or upstream
 * resolver is constructed, and no discovery state persists between pages. */
export class ToolDirectory {
  constructor(private readonly sources: DirectorySources, private readonly cursorKey: string) {}

  list(row: ModelServiceRow, keyId: number, cursor?: string): ListToolsResult {
    const offset = cursor === undefined ? 0 : this.decodeCursor(cursor, row.id, keyId);
    const entries = new Map<string, Entry>();
    let unknownUpstream = false;
    const add = (entry: Entry) => {
      const existing = entries.get(entry.definition.name);
      if (existing && (existing.identity !== entry.identity || !isDeepStrictEqual(existing.definition, entry.definition))) {
        throw new McpError(ErrorCode.InternalError, "Tool discovery contains conflicting downstream names.", { reason: "catalog_conflict" });
      }
      entries.set(entry.definition.name, entry);
    };
    const collectModel = (def: ServiceSteps, available: HostedToolDefinition[]) => {
      if (!isChatPipeline(serviceCategory(def))) return;
      const aliases = new Set<string>();
      for (const tool of available) {
        if (!tool.enabled || !tool.serverTool) continue;
        if (aliases.has(tool.serverTool.name)) configurationError("catalog_conflict");
        aliases.add(tool.serverTool.name);
        toolValidator(tool.parameters); // Same draft-7/local-reference validation as saved tools.
      }
      for (const step of def.steps) {
        const policy = step.serverToolPolicy ?? def.serverToolPolicy ?? DEFAULT_SERVER_TOOL_POLICY;
        if (policy.mode === "blacklist") unknownUpstream = true;
        for (const tool of available) {
          if (!tool.enabled || !tool.serverTool) continue;
          const name = tool.serverTool.name;
          if (policy.mode === "whitelist" && policy.names.includes(name)) continue;
          add({ identity: `hydrogen:${tool.id}`, definition: {
            name, description: [tool.description, ENTRY_NOTICE].filter(Boolean).join("\n\n"),
            inputSchema: structuredClone(tool.parameters) as Tool["inputSchema"],
            _meta: { [DISCOVERY_META]: { discoveryOnly: true, executable: false, provenance: "hydrogen", schemaKnown: true } },
          } });
        }
        if (policy.mode === "whitelist") for (const name of policy.names) {
          add({ identity: `upstream:${name}`, definition: {
            name,
            description: `${ENTRY_NOTICE} Admin-declared upstream availability; not probed. The real parameter schema is unknown. inputSchema is a permissive format placeholder, not a callable or validated contract.`,
            inputSchema: { type: "object", additionalProperties: true },
            _meta: { [DISCOVERY_META]: { discoveryOnly: true, executable: false, provenance: "admin-declared-upstream", schemaKnown: false, inputSchemaIsPlaceholder: true, validatedContract: false, upstreamProbed: false } },
          } });
        }
      }
    };
    const collect = (def: ServiceDef, available: HostedToolDefinition[], stack: number[], includeTools = true) => {
      if (!isAgent(def)) return includeTools ? collectModel(def, available) : undefined;
      for (const stage of def.stages) {
        // This directory describes client-declarable tools, not tools rendered
        // into a prompt as reference or tools in attachment preprocessing.
        // Excluding a stage's tools must not disguise broken configuration.
        const stageTools = includeTools && stage.tools !== "none";
        if (stage.service) {
          const child = this.sources.services.getByName(stage.service);
          if (!child?.enabled) configurationError("unavailable_reference");
          if (stack.includes(child.id) || stack.length > MAX_NESTING) configurationError("invalid_service_graph");
          const childDef = parseService(child.definition);
          if (!isChatPipeline(serviceCategory(childDef))) configurationError("unavailable_reference");
          const combined = new Map(available.map(tool => [tool.id, tool]));
          if (stageTools) for (const tool of this.sources.tools.definitionsForService(child.id)) combined.set(tool.id, tool);
          collect(childDef, [...combined.values()], [...stack, child.id], stageTools);
        } else if (stage.steps?.length && stageTools) {
          collectModel({ timeoutMs: stage.timeoutMs ?? def.timeoutMs, steps: stage.steps }, available);
        }
      }
    };
    try {
      collect(parseService(row.definition), this.sources.tools.definitionsForService(row.id), [row.id]);
    } catch (error) {
      if (error instanceof McpError) throw error;
      configurationError(); // Never serialize Zod/AJV/database messages or private configuration.
    }
    const tools = [...entries.values()].map(entry => entry.definition).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return {
      tools: tools.slice(offset, offset + DISCOVERY_PAGE_SIZE),
      ...(offset + DISCOVERY_PAGE_SIZE < tools.length ? { nextCursor: this.encodeCursor(offset + DISCOVERY_PAGE_SIZE, row.id, keyId) } : {}),
      _meta: { [DISCOVERY_META]: {
        discoveryOnly: true, executable: false, pagination: "live", mayOmitUnknownUpstreamTools: unknownUpstream,
        ...(unknownUpstream ? { warning: "Upstream tools permitted by blacklist policy cannot all be enumerated from local configuration." } : {}),
      } },
    };
  }

  private cursorMac(offset: number, serviceId: number, keyId: number): Buffer {
    return createHmac("sha256", this.cursorKey).update(`hydrogen-discovery:v1:${serviceId}:${keyId}:${offset}`).digest();
  }
  private encodeCursor(offset: number, serviceId: number, keyId: number): string {
    return `v1.${offset}.${this.cursorMac(offset, serviceId, keyId).toString("base64url")}`;
  }
  private decodeCursor(cursor: string, serviceId: number, keyId: number): number {
    const invalid = () => { throw new McpError(ErrorCode.InvalidParams, "Invalid discovery cursor."); };
    if (cursor.length > 80) return invalid();
    const match = /^v1\.([1-9][0-9]{0,15})\.([A-Za-z0-9_-]{43})$/.exec(cursor);
    if (!match) return invalid();
    const offset = Number(match[1]);
    if (!Number.isSafeInteger(offset) || offset % DISCOVERY_PAGE_SIZE !== 0) return invalid();
    const mac = Buffer.from(match[2], "base64url");
    if (!timingSafeEqual(mac, this.cursorMac(offset, serviceId, keyId)) || mac.toString("base64url") !== match[2]) return invalid();
    return offset;
  }
}
