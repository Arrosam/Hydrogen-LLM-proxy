import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db";
import { parseService, parseServiceSteps, ServerToolPolicySchema } from "../src/execution/definition";
import { ServiceRepo } from "../src/persistence/serviceRepo";

const step = { model: "model", provider: "provider" };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

describe("Model Service server-tool policy configuration", () => {
  it("keeps absence distinct from explicit empty policies", () => {
    const absent = parseServiceSteps({ steps: [step] });
    expect(absent).not.toHaveProperty("serverToolPolicy");
    expect(absent.steps[0]).not.toHaveProperty("serverToolPolicy");
    const explicit = parseServiceSteps({
      steps: [{ ...step, serverToolPolicy: { mode: "blacklist", names: [] } }],
      serverToolPolicy: { mode: "whitelist", names: ["web_search"] },
    });
    expect(explicit.serverToolPolicy).toEqual({ mode: "whitelist", names: ["web_search"] });
    expect(explicit.steps[0].serverToolPolicy).toEqual({ mode: "blacklist", names: [] });
  });

  it("round-trips service policy and whole empty step overrides through persistence", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-policy-config-"));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { db, sqlite } = openDatabase(dir);
    cleanup.push(() => sqlite.close());
    const repo = new ServiceRepo(db);
    const definition = parseServiceSteps({ steps: [
      step,
      { ...step, serverToolPolicy: { mode: "whitelist", names: [] } },
      { ...step, serverToolPolicy: { mode: "blacklist", names: [] } },
    ], serverToolPolicy: { mode: "blacklist", names: ["web_search", "Web_Search"] } });
    const row = repo.create({ name: "policy-service", definition });
    expect(repo.def(repo.get(row.id)!)).toEqual(definition);
  });

  it.each([
    { mode: "allow", names: [] },
    { mode: "blacklist" },
    { mode: "whitelist", names: [""] },
    { mode: "whitelist", names: [" web_search"] },
    { mode: "whitelist", names: ["anthropic:web_search"] },
    { mode: "whitelist", names: ["web_search@20250305"] },
    { mode: "whitelist", names: ["x".repeat(65)] },
    { mode: "whitelist", names: ["web_search"], types: ["web_search_20250305"] },
    { mode: "whitelist", names: Array.from({ length: 201 }, (_, i) => `tool_${i}`) },
  ])("rejects malformed or qualified policy input %#", policy => {
    expect(ServerToolPolicySchema.safeParse(policy).success).toBe(false);
    expect(() => parseServiceSteps({ steps: [step], serverToolPolicy: policy })).toThrow();
    expect(() => parseServiceSteps({ steps: [{ ...step, serverToolPolicy: policy }] })).toThrow();
  });

  it("preserves case and the maximum plain-name and list boundaries", () => {
    const names = ["Web_Search", "web_search", "x".repeat(64), ...Array.from({ length: 197 }, (_, i) => `tool_${i}`)];
    expect(ServerToolPolicySchema.parse({ mode: "whitelist", names })).toEqual({ mode: "whitelist", names });
  });

  it.each(["micro_agent", "agent"])("rejects %s root and stage policies with Model Service migration guidance", kind => {
    const agent = { kind, stages: [{ name: "main", service: "policy-service", input: [] }] };
    const policy = { mode: "whitelist", names: [] };
    expect(() => parseService({ ...agent, serverToolPolicy: policy })).toThrow(/referenced Model Service/);
    expect(() => parseService({ ...agent, stages: [{ ...agent.stages[0], serverToolPolicy: policy }] })).toThrow(/referenced Model Service/);
    expect(parseService(agent)).not.toHaveProperty("serverToolPolicy");
  });
});
