import { afterEach, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({resolve:vi.fn(),agents:[] as Array<{close:ReturnType<typeof vi.fn>;destroy:ReturnType<typeof vi.fn>}>}));
vi.mock("../src/core/upstream/egress/proxyHost",()=>({resolveProxyHost:mocks.resolve}));
vi.mock("undici",()=>({ProxyAgent:class { close=vi.fn(()=>new Promise<void>(()=>{}));destroy=vi.fn(async()=>{});constructor(){mocks.agents.push(this);} }}));
import { EgressProxyPool } from "../src/core/upstream/egress/pool";
const proxy=(id:number)=>({id,name:`p${id}`,scheme:"http" as const,host:`proxy${id}.example`,port:8080,username:null,password:null});
const addresses=[{address:"8.8.8.8",family:4}];
afterEach(()=>{vi.restoreAllMocks();mocks.resolve.mockReset();mocks.agents.length=0;});
it("does not resurrect a dispatcher forgotten during DNS refresh",async()=>{
 let now=100;vi.spyOn(Date,"now").mockImplementation(()=>now);mocks.resolve.mockResolvedValue(addresses);
 const pool=new EgressProxyPool();const original=await pool.dispatcherFor(proxy(1));now+=31000;
 let resolved!:(v:typeof addresses)=>void;mocks.resolve.mockImplementationOnce(()=>new Promise(r=>{resolved=r;}));
 const waiting=pool.dispatcherFor(proxy(1));pool.forgetProxy(proxy(1));resolved(addresses);const fresh=await waiting;
 expect(fresh).not.toBe(original);expect(mocks.agents[0].destroy).toHaveBeenCalledOnce();await pool.closeAll();
});
it("LRU eviction drains active pools, while shutdown destroys both cached and retiring pools",async()=>{
 mocks.resolve.mockResolvedValue(addresses);const pool=new EgressProxyPool();
 for(let id=0;id<33;id++) await pool.dispatcherFor(proxy(id));
 expect(mocks.agents[0].close).toHaveBeenCalledOnce();expect(mocks.agents[0].destroy).not.toHaveBeenCalled();
 await pool.closeAll();expect(mocks.agents.every(a=>a.destroy.mock.calls.length===1)).toBe(true);
});
