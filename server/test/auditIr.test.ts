import { expect, it } from "vitest";
import { collectStream, fabricateStream, type StreamEvent } from "../src/core/ir/stream";
import { addUsage, ZERO_USAGE } from "../src/core/ir/usage";
import { requireAnswer } from "../src/core/ir/answer";
async function* events(...items: StreamEvent[]) { yield* items; }
it("keeps initial prompt accounting on a truncated stream", async () => {
 const r = await collectStream(events({type:"start", id:"a", model:"m", created:1, inputTokens:42, cachedInputTokens:10}));
 expect(r.incomplete).toBe(true);
 expect(r.data.usage).toMatchObject({promptTokens:42, totalTokens:42, cachedInputTokens:10, incomplete:true});
});
it("keeps incomplete accounting when summing stages", () => {
 expect(addUsage(ZERO_USAGE, {...ZERO_USAGE, incomplete:true}).incomplete).toBe(true);
 expect(addUsage({...ZERO_USAGE, incomplete:true}, ZERO_USAGE).incomplete).toBe(true);
});
it("round trips executed server tool content through buffering and answer validation", async () => {
 const part = {type:"server_tool_result" as const, family:"openai_responses" as const, id:"s", name:"web_search", input:{query:"test"}, blockType:"web_search_result", content:[{url:"https://example.com"}]};
 const r = await collectStream(requireAnswer(fabricateStream({id:"a",model:"m",created:1,content:[part],stopReason:"stop",usage:ZERO_USAGE}, Infinity)));
 expect(r.data.content).toEqual([part]);
 expect(r.incomplete).toBe(false);
});
