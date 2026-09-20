import { afterEach, expect, it, vi } from "vitest";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { TokenRepo } from "../src/persistence/tokenRepo";
import { requireClientToken } from "../src/auth/tokenAuth";
import { mergeParams, mergeOverrides } from "../src/core/ir/params";
import { fuzzyRewriteUrl } from "../src/transport/fuzzyUrl";
import { toId } from "../src/util/validate";
import { redactHeaders } from "../src/observability/redactor";
import { generateToken, hashToken } from "../src/security/tokens";
import { chatUrl, buildHeaders } from "../src/core/upstream/endpoints";
import { openWithPassphrase, type SealedPayload } from "../src/security/passphrase";
import { classifyError } from "../src/execution/steps";
afterEach(() => vi.restoreAllMocks());
it.each([
 [undefined, null, true, 401], ["key", null, true, 401],
 ["key", {enabled:false}, true, 401],
 ["key", {expiresAt:999}, false, 401], ["key", {expiresAt:1000}, true, 200], ["key", {expiresAt:1001}, true, 200],
 ["key", {maxTokens:10,usedTokens:9}, true, 200], ["key", {maxTokens:10,usedTokens:10}, true, 429],
 ["key", {maxRequests:0,usedRequests:0}, true, 429], ["key", {maxTokens:0,usedTokens:0}, true, 429],
 ["key", {maxRequests:0,maxTokens:0}, false, 200],
])("enforces key expiry/quota boundary %#", async (key, fields, enforce, expected) => {
 vi.spyOn(Date,"now").mockReturnValue(1000);
 const token = fields === null ? null : {enabled:true, expiresAt:null, maxRequests:null,maxTokens:null,usedRequests:0,usedTokens:0,...fields};
 const req = {headers:key ? {authorization:`Bearer ${key}`} : {}} as FastifyRequest;
 let status=200;
 const reply = {code(n:number){status=n;return this;},send(){return this;}} as unknown as FastifyReply;
 await requireClientToken({authenticate:()=>token} as unknown as TokenRepo,"openai_completion",enforce)(req,reply);
 expect(status).toBe(expected);
 expect(req.clientToken !== undefined).toBe(expected===200);
});
it("deep merges independent params and ignores a null extra", () => {
 const base={extra:{a:{one:1}}}; const patch={extra:{a:{two:2}}};
 const out=mergeParams(base,patch);
 expect(out.extra).toEqual({a:{one:1,two:2}});
 (out.extra!.a as {one:number}).one=99;
 expect(base.extra.a.one).toBe(1);
 expect(mergeParams(base,{extra:null} as never).extra).toEqual(base.extra);
 const copy=mergeOverrides(undefined,patch)!;
 (copy.extra!.a as {two:number}).two=9;
 expect(patch.extra.a.two).toBe(2);
});
it.each([
 ["POST", undefined, {}, "/"], ["POST","/admin/messages",{},"/admin/messages"],
 ["GET","//v1/models/?x=1",{},"/v1/models?x=1"], ["POST","/v1",{"x-api-key":"x"},"/v1/messages"],
 ["POST","/v1",{},"/v1/chat/completions"], ["GET","/v1",{},"/v1"],
 ["POST","/administrator/messages",{},"/v1/messages"], ["POST","/unknown",{},"/unknown"],
 ["GET","//assets/app.js",{},"//assets/app.js"]
])("rewrites URL rule %#",(method,url,headers,expected)=>expect(fuzzyRewriteUrl(method,url,headers)).toBe(expected));
it.each(["1e3"," 1 ",true,null,{},"1.5","-1","0","9007199254740992"])("rejects ambiguous id %s",value=>expect(toId(value)).toBeNull());
it("accepts positive integer ids",()=>{expect(toId("123")).toBe(123);expect(toId(1)).toBe(1);});
it("redacts credentials regardless of header case and preserves ordinary headers",()=>{
 expect(redactHeaders({Authorization:"secret", "X-Api-Key":"secret",Cookie:["a","b"],"Set-Cookie":"secret","Proxy-Authorization":"secret","API-Key":"secret",Accept:"json"})).toEqual({authorization:"[redacted]","x-api-key":"[redacted]",cookie:"[redacted]","set-cookie":"[redacted]","proxy-authorization":"[redacted]","api-key":"[redacted]",accept:"json"});
});
it("generates distinct secret keys with stable hashes and non-secret display prefixes",()=>{
 const a=generateToken(),b=generateToken();expect(a.token).not.toBe(b.token);expect(hashToken(a.token)).toBe(a.hash);expect(a.hash).toHaveLength(64);expect(a.prefix.length).toBeLessThan(a.token.length);
});
it("constructs endpoints and prevents configured framing/auth header injection",()=>{
 const p={type:"openai_completion" as const,baseUrl:"https://example.com/v1///",apiKey:"real",extraHeaders:{HOST:"evil",Authorization:"wrong"}};
 expect(chatUrl(p)).toBe("https://example.com/v1/chat/completions");expect(buildHeaders(p)).toMatchObject({authorization:"Bearer real"});expect(buildHeaders(p)).not.toHaveProperty("host");
});
it.each(["", "!!!", Buffer.alloc(15).toString("base64"), Buffer.alloc(17).toString("base64")])("rejects malformed salt %s",async salt=>{
 await expect(openWithPassphrase({kdf:"scrypt",n:32768,r:8,p:1,salt} as SealedPayload,"passphrase")).rejects.toThrow(/salt/);
});
it.each([{n:0},{n:3},{n:2**21},{r:0},{r:33},{p:0},{p:17},{n:2**20,r:32}])("rejects unsafe KDF bounds %j",async patch=>{
 await expect(openWithPassphrase({kdf:"scrypt",n:32768,r:8,p:1,salt:Buffer.alloc(16).toString("base64"),...patch} as SealedPayload,"passphrase")).rejects.toThrow(/key-derivation/);
});
it.each(["UpstreamUrlError","FormatConversionError"])("does not retry permanent %s merely because its URL contains timeout",name=>{
 const error=new Error("https://timeout.example.com");error.name=name;expect(classifyError(error).kind).toBe("error");
});
