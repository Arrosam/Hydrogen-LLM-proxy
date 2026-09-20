import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { UpstreamClient } from "../src/core/upstream/client";
import { SsrfGuard } from "../src/core/upstream/ssrf";
import { inlineUrlFiles } from "../src/execution/fileFetch";
import { AnthropicRequest } from "../src/core/format";
import type { Transport } from "../src/core/upstream/transport";
import { withJsonHeartbeat, JsonKeepalive } from "../src/transport/jsonKeepalive";
import type { FastifyReply } from "fastify";
let server:Server|undefined;
afterEach(async()=>{vi.useRealTimers();if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}});
it("rejects malformed success JSON and deadlines an active dripping GET",async()=>{
 server=createServer((req,res)=>{if(req.url==="/json"){res.end("{broken");return;}res.writeHead(200);res.write("a");const timer=setInterval(()=>res.write("a"),10);res.on("close",()=>clearInterval(timer));});
 await new Promise<void>(resolve=>server!.listen(0,"127.0.0.1",resolve));const port=(server.address() as {port:number}).port;
 const client=new UpstreamClient(new SsrfGuard({allowPrivate:false,allowlist:()=>["127.0.0.1"]}));
 try {
  await expect(client.getJson(`http://127.0.0.1:${port}/json`,{},{timeoutMs:1000})).rejects.toThrow("invalid JSON");
  const started=Date.now();const response=await client.getStream(`http://127.0.0.1:${port}/drip`,{},{timeoutMs:150});
  await expect((async()=>{for await(const chunk of response.body) void chunk;})()).rejects.toThrow();expect(Date.now()-started).toBeLessThan(1500);
 } finally { await (client as unknown as { dispatcher: { destroy(): Promise<void> } }).dispatcher.destroy(); }
});
it("cancels a URL-file download even if its transport ignores the signal",async()=>{
 const controller=new AbortController();const body=new Readable({read(){}});
 const transport={getStream:async()=>({status:200,headers:{},body})} as unknown as Transport;
 const req=AnthropicRequest.parse({model:"m",messages:[{role:"user",content:[{type:"document",source:{type:"url",url:"https://example.com/a.pdf"}}]}]});
 const pending=inlineUrlFiles(req,"openai_completion",transport,{timeoutMs:1000,signal:controller.signal});
 setTimeout(()=>controller.abort(new Error("cancel file")),10);
 await expect(pending).rejects.toThrow("cancel file");expect(body.destroyed).toBe(true);
});
it("ends hijacked JSON on exceptions and clears all timers on finish",async()=>{
 vi.useFakeTimers();let raw="";const end=vi.fn();const reply={hijack:vi.fn(),log:{error:vi.fn()},raw:{headersSent:false,destroyed:false,writableEnded:false,writeHead:vi.fn(),write:(s:string)=>{raw+=s;},end}} as unknown as FastifyReply;
 const promise=withJsonHeartbeat(reply,10,10,async()=>{await new Promise(r=>setTimeout(r,30));throw new Error("private detail");});
 await vi.advanceTimersByTimeAsync(40);await promise;expect(end).toHaveBeenCalledOnce();expect(JSON.parse(raw)).toEqual({error:"request failed"});expect(vi.getTimerCount()).toBe(0);
 const guard=new JsonKeepalive(reply,10,10);guard.finish({ok:true});expect(vi.getTimerCount()).toBe(0);
});
