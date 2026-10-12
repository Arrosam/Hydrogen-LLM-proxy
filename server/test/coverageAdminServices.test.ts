/**
 * Characterization of the Model Service / Micro Agent admin routes: CRUD,
 * validate, the chat dry-run, hosted-tool binding rules, and every Micro-Agent
 * structural rule the validator enforces -- each observed through HTTP, where
 * `/services/validate` answers 200 {valid:false} and `/services` answers 400
 * for the very same definition.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeUpstream, type FakeUpstream } from "./fixtures/fakeUpstream";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

let h: AdminHarness;
let upstream: FakeUpstream;
let toolId: number;

const STEP = { model: "m", provider: "fake" };
const CHAT = { timeoutMs: 30_000, steps: [STEP] };
const EMBEDDING = { category: "embedding", timeoutMs: 30_000, steps: [STEP] };
const stage = (name: string, extra: Record<string, unknown> = {}) => ({ name, input: [], steps: [STEP], ...extra });
const agent = (stages: unknown[], extra: Record<string, unknown> = {}) => ({ kind: "micro_agent", timeoutMs: 30_000, stages, ...extra });
const SERVICE_KEYS = ["createdAt", "description", "enabled", "id", "name", "steps", "summary", "toolIds"];

beforeAll(async () => {
  upstream = await startFakeUpstream({ text: "dry-run answer", script: [] });
  h = await startAdminHarness("cov-services", { ALLOW_PRIVATE_UPSTREAMS: "1" });
  const provider = h.c.providers.create({ name: "fake", type: "openai_completion", baseUrl: upstream.baseUrl, apiKey: "k" });
  const model = h.c.models.create({ name: "m" });
  h.c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });

  const tool = await h.admin({
    method: "POST",
    url: "/tools",
    payload: { name: "lookup", url: "https://adapter.invalid/run", parameters: { type: "object" }, bodyTemplate: { args: "{{arguments}}" }, headers: {} },
  });
  expect(tool.statusCode).toBe(201);
  toolId = tool.json().tool.id;
});

afterAll(async () => {
  await h.close();
  await upstream.close();
});

const create = (payload: unknown) => h.admin({ method: "POST", url: "/services", payload });
const validate = (steps: unknown) => h.admin({ method: "POST", url: "/services/validate", payload: { steps } });

describe("create", () => {
  it("answers 201 with the presented service", async () => {
    const res = await create({ name: "chat", description: "d", steps: CHAT });
    expect(res.statusCode).toBe(201);
    const { service } = res.json();
    expect(Object.keys(service).sort()).toEqual(SERVICE_KEYS);
    expect(service).toMatchObject({ id: expect.any(Number), name: "chat", description: "d", enabled: true, toolIds: [], createdAt: expect.any(Number) });
    expect(service.summary).toContain("m@fake");
    expect(service.steps.steps[0]).toMatchObject(STEP);
  });

  it("a duplicate name is a 409 from the app-wide constraint mapper", async () => {
    const res = await create({ name: "chat", steps: CHAT });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "resource already exists (unique constraint)" });
  });

  it("an invalid envelope is 400 `path: message`; an invalid definition is 400 `invalid steps: ...`", async () => {
    const envelope = await create({});
    expect(envelope.statusCode).toBe(400);
    expect(envelope.json()).toEqual({ error: "name: Required" });

    const longName = await create({ name: "n".repeat(121), steps: CHAT });
    expect(longName.statusCode).toBe(400);
    expect(longName.json()).toEqual({ error: "name: String must contain at most 120 character(s)" });

    const shape = await create({ name: "bad-shape", steps: {} });
    expect(shape.statusCode).toBe(400);
    expect(shape.json()).toEqual({ error: "invalid steps: steps: Required" });
    expect(h.c.services.getByName("bad-shape")).toBeUndefined();
  });

  it("an unmapped (model, provider) pair is 400 and lists the pairs", async () => {
    const res = await create({ name: "unmapped", steps: { timeoutMs: 30_000, steps: [{ model: "ghost", provider: "fake" }, STEP, { model: "m", provider: "nowhere" }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "These (model, provider) pairs are not mapped in the catalog: ghost@fake, m@nowhere",
      invalidPairs: ["ghost@fake", "m@nowhere"],
    });
  });
});

describe("list", () => {
  it("presents every service, to a manager as well", async () => {
    const res = await h.manager({ url: "/services" });
    expect(res.statusCode).toBe(200);
    const { services } = res.json();
    expect(services.map((s: { name: string }) => s.name)).toContain("chat");
    for (const s of services) expect(Object.keys(s).sort()).toEqual(SERVICE_KEYS);
  });

  it("a stored definition that no longer parses is listed with a placeholder summary", async () => {
    const id = (await create({ name: "rotten", steps: CHAT })).json().service.id;
    h.c.sqlite.prepare("UPDATE model_services SET definition_json = ? WHERE id = ?").run(JSON.stringify({ nonsense: true }), id);
    const listed = (await h.admin({ url: "/services" })).json().services.find((s: { id: number }) => s.id === id);
    expect(listed.summary).toBe("(invalid steps)");
    h.c.services.delete(id);
  });
});

describe("update", () => {
  let id: number;
  beforeAll(async () => {
    id = (await create({ name: "edit-me", steps: CHAT })).json().service.id;
  });

  it("patches name / description / enabled and keeps the definition", async () => {
    const res = await h.admin({ method: "PATCH", url: `/services/${id}`, payload: { enabled: false, description: "off", name: "edited" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().service).toMatchObject({ id, name: "edited", description: "off", enabled: false });
    expect(res.json().service.steps.steps[0]).toMatchObject(STEP);

    const noop = await h.admin({ method: "PATCH", url: `/services/${id}`, payload: {} });
    expect(noop.statusCode).toBe(200);
    expect(noop.json().service).toMatchObject({ id, name: "edited", enabled: false });
  });

  it("replaces the definition, refusing an invalid one", async () => {
    const res = await h.admin({ method: "PATCH", url: `/services/${id}`, payload: { steps: { timeoutMs: 45_000, steps: [STEP] } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().service.steps.timeoutMs).toBe(45_000);

    const bad = await h.admin({ method: "PATCH", url: `/services/${id}`, payload: { steps: { timeoutMs: 45_000, steps: [{ model: "ghost", provider: "fake" }] } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().invalidPairs).toEqual(["ghost@fake"]);
    expect(h.c.services.def(h.c.services.get(id)!)).toMatchObject({ timeoutMs: 45_000 });
  });

  it("invalid id 400, unknown id 404, invalid body 400 (existence is checked before the body)", async () => {
    const bad = await h.admin({ method: "PATCH", url: "/services/abc", payload: {} });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid id" });

    const missing = await h.admin({ method: "PATCH", url: "/services/99999", payload: { name: "" } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not found" });

    const body = await h.admin({ method: "PATCH", url: `/services/${id}`, payload: { name: "" } });
    expect(body.statusCode).toBe(400);
    expect(body.json()).toEqual({ error: "name: String must contain at least 1 character(s)" });
  });
});

describe("delete", () => {
  it("invalid id 400, unknown id 404, success 200 {ok:true}", async () => {
    const bad = await h.admin({ method: "DELETE", url: "/services/abc" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid id" });

    const missing = await h.admin({ method: "DELETE", url: "/services/99999" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not found" });

    const id = (await create({ name: "doomed", steps: CHAT })).json().service.id;
    const ok = await h.manager({ method: "DELETE", url: `/services/${id}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(h.c.services.get(id)).toBeUndefined();
  });
});

describe("hosted-tool binding", () => {
  it("an admin binds tools to a chat service at create and rebinds on patch", async () => {
    const res = await create({ name: "with-tools", steps: CHAT, toolIds: [toolId] });
    expect(res.statusCode).toBe(201);
    const id = res.json().service.id;
    expect(res.json().service.toolIds).toEqual([toolId]);

    const untouched = await h.admin({ method: "PATCH", url: `/services/${id}`, payload: { description: "still bound" } });
    expect(untouched.json().service.toolIds).toEqual([toolId]);

    const unbound = await h.admin({ method: "PATCH", url: `/services/${id}`, payload: { toolIds: [] } });
    expect(unbound.statusCode).toBe(200);
    expect(unbound.json().service.toolIds).toEqual([]);
  });

  it("tools require a chat service: at create, and on a patch that changes the category under an existing binding", async () => {
    const res = await create({ name: "emb-tools", steps: EMBEDDING, toolIds: [toolId] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Hosted tools require a chat service" });
    expect(h.c.services.getByName("emb-tools")).toBeUndefined();

    // An embedding service with an EMPTY tool list is fine.
    expect((await create({ name: "emb-no-tools", steps: EMBEDDING, toolIds: [] })).statusCode).toBe(201);

    const bound = (await create({ name: "bound-chat", steps: CHAT, toolIds: [toolId] })).json().service.id;
    const flip = await h.admin({ method: "PATCH", url: `/services/${bound}`, payload: { steps: EMBEDDING } });
    expect(flip.statusCode).toBe(400);
    expect(flip.json()).toEqual({ error: "Hosted tools require a chat service" });
    expect((h.c.services.def(h.c.services.get(bound)!) as { category?: string }).category ?? "chat").toBe("chat");
  });

  it("a manager manages services but may not send toolIds at all -- not even an empty list", async () => {
    const plain = await h.manager({ method: "POST", url: "/services", payload: { name: "by-manager", steps: CHAT } });
    expect(plain.statusCode).toBe(201);
    const id = plain.json().service.id;
    expect((await h.manager({ method: "PATCH", url: `/services/${id}`, payload: { description: "m" } })).statusCode).toBe(200);

    const bind = await h.manager({ method: "POST", url: "/services", payload: { name: "mgr-tools", steps: CHAT, toolIds: [toolId] } });
    expect(bind.statusCode).toBe(403);
    expect(bind.json()).toEqual({ error: "only an admin can bind hosted tools" });
    expect(h.c.services.getByName("mgr-tools")).toBeUndefined();

    const rebind = await h.manager({ method: "PATCH", url: `/services/${id}`, payload: { toolIds: [] } });
    expect(rebind.statusCode).toBe(403);
    expect(rebind.json()).toEqual({ error: "only an admin can bind hosted tools" });

    // The envelope is validated before the gate: a malformed body is a 400 for a manager too.
    expect((await h.manager({ method: "POST", url: "/services", payload: { toolIds: [toolId] } })).statusCode).toBe(400);
  });
});

describe("POST /services/validate", () => {
  it("a valid chain and a valid agent report kind, count and summary", async () => {
    const chain = await validate({ timeoutMs: 30_000, steps: [STEP, STEP] });
    expect(chain.statusCode).toBe(200);
    expect(chain.json()).toEqual({ valid: true, summary: expect.stringContaining("m@fake"), kind: "resilience", count: 2 });

    const micro = await validate(agent([stage("a"), stage("b")]));
    expect(micro.statusCode).toBe(200);
    expect(micro.json()).toEqual({ valid: true, summary: "agent: a -> b", kind: "agent", count: 2 });
  });

  it("an invalid definition is still HTTP 200, with valid:false -- where create answers 400", async () => {
    const shape = await validate({});
    expect(shape.statusCode).toBe(200);
    expect(shape.json()).toEqual({ valid: false, error: "invalid steps: steps: Required" });

    const none = await h.admin({ method: "POST", url: "/services/validate" });
    expect(none.statusCode).toBe(200);
    expect(none.json().valid).toBe(false);

    const pairs = await validate({ timeoutMs: 30_000, steps: [{ model: "ghost", provider: "fake" }] });
    expect(pairs.statusCode).toBe(200);
    expect(pairs.json()).toEqual({
      valid: false,
      error: "These (model, provider) pairs are not mapped in the catalog: ghost@fake",
      invalidPairs: ["ghost@fake"],
    });
  });
});

describe("Micro-Agent structural rules", () => {
  const router = (name: string, extra: Record<string, unknown> = {}) => ({ name, input: [], ...extra });
  const when = (type: string, value?: string, extra: Record<string, unknown> = {}) => ({ type, ...(value === undefined ? {} : { value }), ...extra });

  const rejected: Array<[string, unknown, string]> = [
    ["two stages with one name", agent([stage("x"), stage("x")]), 'duplicate stage name "x"'],
    [
      "a stage reading a LATER stage's output",
      agent([stage("a", { input: [{ kind: "stage_output", stage: "b" }] }), stage("b")]),
      'stage "a": references "b", which is not an earlier stage',
    ],
    [
      "a stage reading its own output",
      agent([stage("a", { input: [{ kind: "stage_output", stage: "a" }] })]),
      'stage "a": references "a", which is not an earlier stage',
    ],
    [
      "a tool turn whose arguments are not JSON",
      agent([stage("a", { input: [{ kind: "tool_turn", name: "t", input: "{bad" }] })]),
      'stage "a": tool turn "t" has invalid JSON arguments',
    ],
    [
      "a backward goto",
      agent([stage("a"), stage("b", { transitions: [{ when: when("always"), goto: "a" }] })]),
      'stage "b": transition goto "a" must be a later stage (forward-only)',
    ],
    [
      "a goto to itself",
      agent([stage("a", { transitions: [{ when: when("always"), goto: "a" }] })]),
      'stage "a": transition goto "a" must be a later stage (forward-only)',
    ],
    [
      "a goto to a stage that does not exist",
      agent([stage("a", { transitions: [{ when: when("always"), goto: "ghost" }] })]),
      'stage "a": transition goto "ghost" is not a stage',
    ],
    [
      "ending with a later stage's output",
      agent([stage("a", { transitions: [{ when: when("always"), goto: "end", output: "c" }] }), stage("b"), stage("c")]),
      'stage "a": transition returns later stage "c" (must be this or an earlier stage)',
    ],
    [
      "ending with an unknown stage's output",
      agent([stage("a", { transitions: [{ when: when("always"), goto: "end", output: "ghost" }] })]),
      'stage "a": transition returns unknown stage "ghost"',
    ],
    [
      "ending with a router's (non-existent) output",
      agent([router("r"), stage("a", { transitions: [{ when: when("always"), goto: "end", output: "r" }] })]),
      'stage "a": transition returns router stage "r", which produces no output',
    ],
    [
      "a 201-character pattern",
      agent([stage("a", { transitions: [{ when: when("input_matches", "a".repeat(201)), goto: "end" }] })]),
      'stage "a": condition regex is too long (201 chars, max 200)',
    ],
    [
      "a pattern that does not compile",
      agent([stage("a", { transitions: [{ when: when("output_matches", "("), goto: "end" }] })]),
      'stage "a": invalid regex "("',
    ],
    [
      "a router testing its own output",
      agent([router("r", { transitions: [{ when: when("output_contains", "x"), goto: "a" }] }), stage("a")]),
      'stage "r": cannot test output -- a router makes no model call',
    ],
    [
      "a condition on a later stage's output",
      agent([stage("a", { transitions: [{ when: when("output_contains", "x", { stage: "c" }), goto: "b" }] }), stage("b"), stage("c")]),
      'stage "a": condition references later stage "c"',
    ],
    [
      "a condition on an unknown stage's output",
      agent([stage("a", { transitions: [{ when: when("output_matches", "x", { stage: "ghost" }), goto: "end" }] })]),
      'stage "a": condition references unknown stage "ghost"',
    ],
    ["an output stage that is not defined", agent([stage("a")], { output: "ghost" }), 'output stage "ghost" is not a defined stage'],
    [
      "a stage naming a service that does not exist",
      agent([{ name: "a", input: [], service: "ghost" }]),
      'stage "a": references unknown Model Service or Micro Agent "ghost"',
    ],
    ["an OCR pre-pass with no model", agent([stage("a")], { ocr: {} }), "image translation (OCR) is enabled but has no model (pick a Model Service)"],
    [
      "an OCR pre-pass naming an unknown service",
      agent([stage("a")], { ocr: { service: "ghost" } }),
      'image translation (OCR) references unknown Model Service "ghost"',
    ],
    ["an ASR pre-pass with no model", agent([stage("a")], { asr: {} }), "audio transcription (ASR) is enabled but has no model (pick an stt Model Service)"],
  ];

  it.each(rejected)("rejects %s", async (_title, steps, error) => {
    const checked = await validate(steps);
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toEqual({ valid: false, error, invalidPairs: [] });

    const created = await create({ name: "never-saved", steps });
    expect(created.statusCode).toBe(400);
    expect(created.json()).toEqual({ error, invalidPairs: [] });
    expect(h.c.services.getByName("never-saved")).toBeUndefined();
  });

  it("a stage may not run a media service", async () => {
    const res = await validate(agent([{ name: "a", input: [], service: "emb-no-tools" }]));
    expect(res.json()).toEqual({
      valid: false,
      error: 'stage "a": references "emb-no-tools", a embedding service — only chat/OCR services can run inside a Micro Agent',
      invalidPairs: [],
    });
  });

  it("an unmapped pair inside a stage is reported like one in a chain", async () => {
    const res = await validate(agent([{ name: "a", input: [], steps: [{ model: "ghost", provider: "fake" }] }]));
    expect(res.json()).toEqual({
      valid: false,
      error: "These (model, provider) pairs are not mapped in the catalog: ghost@fake",
      invalidPairs: ["ghost@fake"],
    });
  });

  it("accepts the boundary and legal forms next to each rule", async () => {
    const accepted: Array<[string, unknown]> = [
      ["a 200-character pattern", agent([stage("a", { transitions: [{ when: when("input_matches", "a".repeat(200)), goto: "end" }] })])],
      ["an earlier stage's output as input", agent([stage("a"), stage("b", { input: [{ kind: "stage_output", stage: "a" }] })])],
      ["a tool turn with JSON arguments, and one with none", agent([stage("a", { input: [{ kind: "tool_turn", name: "t", input: '{"q":1}' }, { kind: "tool_turn", name: "u" }] })])],
      ["a forward goto", agent([stage("a", { transitions: [{ when: when("input_contains", "skip"), goto: "c" }] }), stage("b"), stage("c")])],
      ["ending with this stage's or an earlier stage's output", agent([stage("a"), stage("b", { transitions: [{ when: when("always"), goto: "end", output: "a" }, { when: when("always"), goto: "end", output: "b" }] })])],
      ["a condition on this stage's own output (stage omitted)", agent([stage("a", { transitions: [{ when: when("output_contains", "x"), goto: "end" }] })])],
      ["a router routing on the input", agent([router("r", { transitions: [{ when: when("input_has_image"), goto: "b" }] }), stage("a"), stage("b")])],
      ["a defined output stage", agent([stage("a"), stage("b")], { output: "a" })],
      ["a stage running a saved chat service", agent([{ name: "a", input: [], service: "chat" }])],
    ];
    for (const [title, steps] of accepted) {
      const res = await validate(steps);
      expect(res.json().valid, `${title}: ${res.body}`).toBe(true);
    }
    expect((await validate(agent([stage("a"), stage("b")], { output: "a" }))).json().summary).toBe("agent: a -> b (returns a)");
  });
});

describe("POST /services/test (dry-run)", () => {
  it("an unknown saved service is 404 with its own message", async () => {
    const res = await h.admin({ method: "POST", url: "/services/test", payload: { serviceId: 99999 } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Model Service not found" });
  });

  it("only chat-pipeline services can be dry-run", async () => {
    const id = h.c.services.getByName("emb-no-tools")!.id;
    const res = await h.admin({ method: "POST", url: "/services/test", payload: { serviceId: id } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "dry-run supports chat-pipeline services only (this is a embedding service)" });
  });

  it("invalid ad-hoc steps are 400, like create", async () => {
    const shape = await h.admin({ method: "POST", url: "/services/test", payload: { steps: {} } });
    expect(shape.statusCode).toBe(400);
    expect(shape.json()).toEqual({ error: "invalid steps: steps: Required" });

    const pairs = await h.admin({ method: "POST", url: "/services/test", payload: { steps: { timeoutMs: 30_000, steps: [{ model: "ghost", provider: "fake" }] } } });
    expect(pairs.statusCode).toBe(400);
    expect(pairs.json().invalidPairs).toEqual(["ghost@fake"]);
  });

  it("runs ad-hoc chat steps against the provider with a 16-token budget", async () => {
    const before = upstream.requests;
    const res = await h.manager({ method: "POST", url: "/services/test", payload: { steps: CHAT, prompt: "hello there" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, served: { model: "m", provider: "fake" }, output: "dry-run answer" });
    expect(body.attemptPath).toHaveLength(1);
    expect(upstream.requests).toBe(before + 1);
    const sent = upstream.bodies[upstream.bodies.length - 1] as { max_tokens?: number; max_completion_tokens?: number; messages: Array<{ content: unknown }> };
    expect(sent.max_tokens ?? sent.max_completion_tokens).toBe(16);
    expect(JSON.stringify(sent.messages)).toContain("hello there");
  });

  it("the default prompt is 'ping', a saved service is run by id, and an agent gets 64 tokens", async () => {
    const saved = await h.admin({ method: "POST", url: "/services/test", payload: { serviceId: h.c.services.getByName("chat")!.id } });
    expect(saved.json()).toMatchObject({ ok: true, output: "dry-run answer" });
    expect(JSON.stringify((upstream.bodies[upstream.bodies.length - 1] as { messages: unknown }).messages)).toContain("ping");

    const micro = await h.admin({ method: "POST", url: "/services/test", payload: { steps: agent([stage("only")]) } });
    expect(micro.json()).toMatchObject({ ok: true, output: "dry-run answer" });
    const sent = upstream.bodies[upstream.bodies.length - 1] as { max_tokens?: number; max_completion_tokens?: number };
    expect(sent.max_tokens ?? sent.max_completion_tokens).toBe(64);
  });
});

describe("POST /services/test when the upstream fails", () => {
  let failing: FakeUpstream;
  beforeAll(async () => {
    failing = await startFakeUpstream({ text: "never", script: Array(8).fill({ kind: "status", status: 500, body: { error: { message: "boom" } } }) });
    const provider = h.c.providers.create({ name: "broken", type: "openai_completion", baseUrl: failing.baseUrl, apiKey: "k" });
    h.c.mappings.create({ modelId: h.c.models.list().find((m) => m.name === "m")!.id, providerId: provider.id, upstreamModel: "up" });
  });
  afterAll(async () => {
    await failing.close();
  });

  it("the failure travels in-body under HTTP 200", async () => {
    const steps = { timeoutMs: 30_000, steps: [{ model: "m", provider: "broken", retry: { maxAttempts: 1 } }] };
    const res = await h.admin({ method: "POST", url: "/services/test", payload: { steps } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: false, status: 500 });
    expect(typeof body.message).toBe("string");
    expect(body.attemptPath).toHaveLength(1);
    expect(failing.requests).toBe(1);
  });
});
