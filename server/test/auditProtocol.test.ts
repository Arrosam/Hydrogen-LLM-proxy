import { expect, it } from "vitest";
import { parseRequest, buildRequest, parseResponse, buildResponse, parseStream, serializeStream } from "../src/core/format";
import { collectStream, fabricateStream, type ResponseData } from "../src/core/ir/stream";
import { ZERO_USAGE } from "../src/core/ir/usage";
import { FAMILIES } from "../src/core/ir/params";
it.each(["completed","failed","in_progress"])("Responses search %s survives request, buffered and streaming replay", async status=>{
 const item={id:"ws1",type:"web_search_call",status,action:{type:"search",queries:["one","two"],sources:[{type:"url",url:"https://example.com"}]}};
 const response=parseResponse("openai_responses",{id:"r",model:"m",created_at:1,status:status==="in_progress"?"incomplete":"completed",incomplete_details:{reason:"pause_turn"},output:[item]});
 const buffered=response.renderSelf("m");expect(buffered.output).toEqual([item]);
 const request=parseRequest("openai_responses",{model:"m",input:[item]});
 const replay=request.render({upstreamModel:"m"});expect(replay.input).toEqual([item]);
 const wire=serializeStream("openai_responses",fabricateStream(response,Infinity),{model:"m"});
 const collected=await collectStream(parseStream("openai_responses",wire));
 expect(buildResponse("openai_responses",collected.data).renderSelf("m").output).toEqual([item]);
});
it.each(["anthropic","openai_responses"] as const)("%s preserves a pending server call without inventing a client function call",async family=>{
 const data:ResponseData={id:"r",created:1,model:"m",content:[{type:"tool_use",serverTool:true,id:"pending",name:"web_search",input:{queries:["one"]}}],stopReason:"pause_turn",usage:ZERO_USAGE};
 const got=await collectStream(parseStream(family,serializeStream(family,fabricateStream(data,Infinity),{model:"m"})));
 expect(got.incomplete).toBe(false);expect(got.data.stopReason).toBe("pause_turn");
 expect(got.data.content[0]).toMatchObject(family==="anthropic"?{type:"tool_use",serverTool:true,id:"pending"}:{type:"server_tool_result",notExecuted:true,id:"pending"});
});
it("retains content filtering across buffered and streaming Responses",async()=>{
 const data:ResponseData={id:"r",model:"m",created:1,content:[{type:"text",text:"partial"}],stopReason:"content_filter",usage:ZERO_USAGE};
 expect(parseResponse("openai_responses",buildResponse("openai_responses",data).renderSelf("m")).stopReason).toBe("content_filter");
 const got=await collectStream(parseStream("openai_responses",serializeStream("openai_responses",fabricateStream(data,Infinity),{model:"m"})));expect(got.data.stopReason).toBe("content_filter");
});
it("preserves Anthropic provider blocks and rejects unknown document representations",()=>{
 const content=[{type:"server_tool_use",id:"s",name:"web_search",input:{query:"one"}},{type:"web_search_tool_result",tool_use_id:"s",content:[{type:"web_search_result",url:"https://example.com",title:"one",encrypted_content:"opaque"}]}];
 const req=parseRequest("anthropic",{model:"m",max_tokens:100,messages:[{role:"assistant",content}]});
 const body=req.render({upstreamModel:"m"});expect((body.messages as any[])[0].content).toMatchObject(content);
 expect(()=>parseRequest("anthropic",{model:"m",messages:[{role:"user",content:[{type:"document",source:{type:"unknown"}}]}]})).toThrow();
});
it.each(FAMILIES)("canonical parameters override passthrough once in %s",family=>{
 const body={model:"m",temperature:0.2,top_p:0.5,max_tokens:50,max_output_tokens:50,messages:[{role:"user",content:"q"}],input:"q",custom_vendor:{flag:true}};
 const req=parseRequest(family,body);req.params.temperature=0.9;
 const out=buildRequest(family,req).render({upstreamModel:"up"});expect(out.temperature).toBe(0.9);expect(out.model).toBe("up");expect(out.custom_vendor).toEqual({flag:true});
});

it("replays configured legacy search-result blocks across Anthropic streaming",async()=>{
 const data:ResponseData={id:"r",created:1,model:"m",content:[{type:"server_tool_result",family:"anthropic",id:"s",name:"web_search",input:{queries:["q"]},blockType:"web_search_result",content:[],errorCode:"unavailable"}],stopReason:"stop",usage:ZERO_USAGE};
 const buffered=buildResponse("anthropic",data).renderSelf("m");
 expect(parseResponse("anthropic",buffered).content).toEqual(data.content);
 const streamed=await collectStream(parseStream("anthropic",serializeStream("anthropic",fabricateStream(data,Infinity),{model:"m"})));expect(streamed.data.content).toEqual(data.content);
});
