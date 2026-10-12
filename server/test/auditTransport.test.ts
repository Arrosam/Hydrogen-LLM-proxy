import { afterEach, describe, expect, it, vi } from "vitest";
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

// ---------------------------------------------------------------------------
// Coverage additions: JsonKeepalive / withJsonHeartbeat state transitions.
// ---------------------------------------------------------------------------

describe("ST: the JSON heartbeat (armed -> committed -> finished | stopped | disabled)", () => {
  interface FakeReply {
    reply: FastifyReply;
    raw: { headersSent: boolean; destroyed: boolean; writableEnded: boolean };
    hijack: ReturnType<typeof vi.fn>;
    writeHead: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    logError: ReturnType<typeof vi.fn>;
    written: () => string;
  }
  function fakeReply(): FakeReply {
    let text = "";
    const hijack = vi.fn();
    const writeHead = vi.fn();
    const end = vi.fn();
    const logError = vi.fn();
    const raw = { headersSent: false, destroyed: false, writableEnded: false, writeHead, write: (s: string) => { text += s; return true; }, end };
    const reply = { hijack, log: { error: logError }, raw } as unknown as FastifyReply;
    return { reply, raw, hijack, writeHead, end, logError, written: () => text };
  }
  const after = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));

  it("a handler that answers inside the grace window returns its body untouched", async () => {
    vi.useFakeTimers();
    const f = fakeReply();
    const promise = withJsonHeartbeat(f.reply, 10, 10, () => after(9, { ok: true }));
    await vi.advanceTimersByTimeAsync(9);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(f.hijack).not.toHaveBeenCalled();
    expect(f.writeHead).not.toHaveBeenCalled();
    expect(f.written()).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100); // the cancelled grace timer never commits later
    expect(f.hijack).not.toHaveBeenCalled();
  });

  it("a handler that throws inside the grace window rethrows the same error and writes nothing", async () => {
    vi.useFakeTimers();
    const f = fakeReply();
    const boom = new Error("handler failed fast");
    const promise = withJsonHeartbeat(f.reply, 10, 10, async () => { throw boom; });
    await expect(promise).rejects.toBe(boom);
    expect(f.hijack).not.toHaveBeenCalled();
    expect(f.written()).toBe("");
    expect(f.end).not.toHaveBeenCalled();
    expect(f.logError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a handler slower than the grace window: 200 is committed, newlines flow, then the JSON, and undefined is returned", async () => {
    vi.useFakeTimers();
    const f = fakeReply();
    const promise = withJsonHeartbeat(f.reply, 10, 10, () => after(35, { answer: 42 }));
    await vi.advanceTimersByTimeAsync(35);
    await expect(promise).resolves.toBeUndefined();
    expect(f.hijack).toHaveBeenCalledOnce();
    expect(f.writeHead).toHaveBeenCalledOnce();
    expect(f.writeHead.mock.calls[0][0]).toBe(200);
    expect((f.writeHead.mock.calls[0][1] as Record<string, string>)["content-type"]).toContain("application/json");
    // One newline at commit (t=10) and one per interval (t=20, t=30).
    expect(f.written()).toBe(`\n\n\n${JSON.stringify({ answer: 42 })}`);
    expect(JSON.parse(f.written())).toEqual({ answer: 42 }); // leading whitespace is valid JSON
    expect(f.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the commit happens at the grace boundary, not before", async () => {
    vi.useFakeTimers();
    const f = fakeReply();
    const guard = new JsonKeepalive(f.reply, 10, 10);
    await vi.advanceTimersByTimeAsync(9);
    expect(guard.committed).toBe(false);
    expect(f.written()).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(guard.committed).toBe(true);
    expect(f.written()).toBe("\n");
    guard.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1])("graceMs=%d disables the guard: nothing is ever committed", async (graceMs) => {
    vi.useFakeTimers();
    const f = fakeReply();
    expect(vi.getTimerCount()).toBe(0);
    const promise = withJsonHeartbeat(f.reply, graceMs, 10, () => after(5_000, { slow: true }));
    expect(vi.getTimerCount()).toBe(1); // only the handler's own timer
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toEqual({ slow: true });
    expect(f.hijack).not.toHaveBeenCalled();
    expect(f.written()).toBe("");
  });

  it("if headers were already sent when the grace window expires, the guard stands down", async () => {
    vi.useFakeTimers();
    const f = fakeReply();
    f.raw.headersSent = true;
    const promise = withJsonHeartbeat(f.reply, 10, 10, () => after(35, { ok: true }));
    await vi.advanceTimersByTimeAsync(35);
    await expect(promise).resolves.toEqual({ ok: true }); // the body goes back to the caller
    expect(f.hijack).not.toHaveBeenCalled();
    expect(f.writeHead).not.toHaveBeenCalled();
    expect(f.written()).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("if the connection is already destroyed when the grace window expires, nothing is committed", async () => {
    vi.useFakeTimers();
    const f = fakeReply();
    f.raw.destroyed = true;
    const guard = new JsonKeepalive(f.reply, 10, 10);
    await vi.advanceTimersByTimeAsync(50);
    expect(guard.committed).toBe(false);
    expect(f.hijack).not.toHaveBeenCalled();
    expect(guard.finish({ ok: true })).toBe(false);
  });

  it("a connection that dies after commit stops the heartbeat, and finish writes nothing but still reports the commit", async () => {
    vi.useFakeTimers();
    const f = fakeReply();
    const guard = new JsonKeepalive(f.reply, 10, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(guard.committed).toBe(true);
    expect(f.written()).toBe("\n");

    f.raw.destroyed = true;
    await vi.advanceTimersByTimeAsync(10); // the tick that notices
    expect(f.written()).toBe("\n");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.written()).toBe("\n");

    expect(guard.finish({ ok: true })).toBe(true); // the reply is hijacked: the caller must not send
    expect(f.written()).toBe("\n");
    expect(f.end).not.toHaveBeenCalled();
  });

  it("stop() before the grace window cancels the commit; finish then defers to the caller", async () => {
    vi.useFakeTimers();
    const f = fakeReply();
    const guard = new JsonKeepalive(f.reply, 10, 10);
    guard.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(guard.committed).toBe(false);
    expect(guard.finish({ ok: true })).toBe(false);
    expect(f.written()).toBe("");
  });
});
