import type { StreamEvent } from "../core/ir/stream";
import type { WireItem } from "../persistence/responseRepo";

/** Only the product's explicit final `answer` commitment crosses the live wire.
 * Search arguments, reasoning and intermediate prose stay inside the hosted loop.
 * A model that asks for more work after committing an answer fails the turn. */
export function fishballAnswerStream(id: string, model: string, emit: (event: WireItem) => Promise<void>) {
  let started = false;
  let index: number | undefined;
  let otherTool = false;
  return {
    get started() { return started; },
    async send(event: StreamEvent): Promise<void> {
      if (event.type === "start") {
        if (started) throw new Error("Model continued after committing its final answer");
        otherTool = false; index = undefined;
      }
      if (event.type === "tool_start") {
        if (started) throw new Error("Model requested more tools after committing its final answer");
        if (event.name !== "answer") { otherTool = true; return; }
        if (otherTool) return; // Mixed local-tool batch is returned through the buffered path.
        started = true; index = event.index;
        await emit({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], usage: { input_tokens: 0, output_tokens: 0 } } });
        await emit({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: event.id, name: "answer", input: {} } });
      }
      if (event.type === "tool_args_delta" && event.index === index) await emit({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: event.delta } });
      if (event.type === "tool_stop" && event.index === index) await emit({ type: "content_block_stop", index: 0 });
    },
  };
}
