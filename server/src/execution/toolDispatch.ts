import type { EgressProxy } from "../core/upstream/egress/types";
import type { Transport } from "../core/upstream/transport";
import type { DispatchableTool } from "../persistence/toolRepo";

/**
 * Calling an operator's tool endpoint.
 *
 * Hydrogen implements no tool (S1). It POSTs a fixed envelope it owns and reads
 * one back, and the operator supplies whatever adapter turns that into a real
 * service. Deliberately no templating, no placeholder interpolation and no
 * response-path extraction: those three are what made the HTTP tool builder
 * large enough to be reverted once already, and leaving them out means there is
 * exactly one contract to document and test.
 */

/** What Hydrogen sends. Stable — an operator's adapter is written against it. */
export interface ToolDispatchRequest {
  /** The tool as the model called it. */
  tool: string;
  /** The model's arguments, already parsed from its JSON string. */
  arguments: unknown;
  /** Correlates with the tool call in the conversation, and with the log. */
  call_id: string;
}

/** What Hydrogen expects back: exactly one of these two. */
export interface ToolDispatchReply {
  output?: unknown;
  error?: unknown;
}

export type ToolDispatchResult =
  | { ok: true; output: string }
  /** Not a failed request: an errored result is handed to the model, which
   * writes around it, exactly as a provider's own failing tool does. */
  | { ok: false; error: string };

/** Render whatever the endpoint returned as the text the model will read. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface DispatchDeps {
  transport: Transport;
  /** Resolve a proxy id to the egress the transport wants. Absent = direct. */
  resolveProxy?: (id: number) => EgressProxy | null | undefined;
}

/**
 * Dispatch one tool call and return what the model should be told.
 *
 * Never throws and never fails the turn. Every outcome — a refused connection,
 * a timeout, a 500, an endpoint that answers with `{error}`, or one that answers
 * with neither field — becomes an errored tool result, because a tool that fails
 * mid-turn must leave the model able to write around it (Behavior 6). The
 * request has usually already streamed text to the client by this point, so the
 * alternative is a half answer and a dead conversation.
 *
 * Not retried (E6): the endpoint may not be idempotent, and re-firing an
 * operator's write because their service was briefly slow is not Hydrogen's
 * call to make.
 */
export async function dispatchTool(
  entry: DispatchableTool,
  call: ToolDispatchRequest,
  deps: DispatchDeps,
): Promise<ToolDispatchResult> {
  const proxy = entry.proxyId != null ? deps.resolveProxy?.(entry.proxyId) : undefined;
  try {
    const res = await deps.transport.postJson(
      entry.endpointUrl,
      { "content-type": "application/json", ...entry.headers },
      { tool: call.tool, arguments: call.arguments, call_id: call.call_id } satisfies ToolDispatchRequest,
      { timeoutMs: entry.timeoutMs, ...(proxy ? { proxy } : {}) },
    );

    if (res.status < 200 || res.status >= 300) {
      // The body is included because it is the operator's own error message and
      // the only thing that will tell them what their adapter did.
      return { ok: false, error: `tool "${entry.name}" endpoint returned HTTP ${res.status}: ${res.text.slice(0, 500)}` };
    }

    const reply = (res.json ?? {}) as ToolDispatchReply;
    if (reply.error !== undefined) return { ok: false, error: asText(reply.error) };
    if (reply.output !== undefined) return { ok: true, output: asText(reply.output) };
    return {
      ok: false,
      error: `tool "${entry.name}" endpoint returned neither "output" nor "error"`,
    };
  } catch (e) {
    // Timeout, DNS failure, refused connection, blocked by the SSRF guard.
    return { ok: false, error: `tool "${entry.name}" endpoint failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Per-request dispatch budget.
 *
 * `max_uses` is per tool rather than a single global round cap, mirroring the
 * shape a real provider uses. Exhausting it yields an errored result the model
 * can read and route around, not a failed request.
 */
export class DispatchBudget {
  private readonly used = new Map<number, number>();
  /** Total dispatches, reported alongside tokens so an operator can bill them. */
  private total = 0;

  constructor(private readonly hardCap = 64) {}

  get dispatches(): number {
    return this.total;
  }

  /** Consume one use of `entry`, or explain why it cannot be consumed. */
  take(entry: DispatchableTool): { ok: true } | { ok: false; error: string } {
    if (this.total >= this.hardCap) {
      return { ok: false, error: `this request has reached its overall limit of ${this.hardCap} tool calls` };
    }
    const used = this.used.get(entry.id) ?? 0;
    if (used >= entry.maxUses) {
      return { ok: false, error: `tool "${entry.name}" has reached its limit of ${entry.maxUses} uses for this request` };
    }
    this.used.set(entry.id, used + 1);
    this.total += 1;
    return { ok: true };
  }
}
