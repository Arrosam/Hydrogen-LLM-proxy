import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { releasePlan } from "./release-plan.mjs";

const sha = "47397d97c209af695b7fc01ed376f2ddeaeda06b";
test("package and lock versions produce an isolated preview plan", () => {
  const read = name => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));
  const version = read("package.json").version;
  assert.match(version, /^\d+\.\d+\.\d+-preview\.\d+$/);
  const lock = read("package-lock.json");
  assert.equal(lock.version, version);
  for (const workspace of ["", "server", "web"]) {
    assert.equal(read(`${workspace ? `${workspace}/` : ""}package.json`).version, version);
    assert.equal(lock.packages[workspace].version, version);
  }
  const plan = releasePlan({ ref: `refs/tags/v${version}`, sha });
  assert.equal(plan.channel, "preview");
  assert.equal(plan.prerelease, true);
  assert.equal(plan.latest, false);
  assert.deepEqual(plan.imageTags, ["preview", `preview-v${version}`, `preview-sha-${sha.slice(0, 12)}`]);
  assert.deepEqual(plan.githubReleaseArgs, ["release", "create", `v${version}`, "--verify-tag", "--prerelease", "--latest=false"]);
});
for (const ref of ["refs/heads/main", "refs/tags/v2.2.4", "refs/tags/v2.2.4-preview.1"]) {
  test(`default preview isolates ${ref}`, () => {
    const plan = releasePlan({ ref, sha });
    assert.equal(plan.channel, "preview");
    assert.equal(plan.prerelease, true);
    assert.equal(plan.latest, false);
    assert.ok(plan.imageTags.every(tag => tag === "preview" || tag.startsWith("preview-")));
    assert.ok(!plan.imageTags.some(tag => ["latest", "stable", "v2.2.4"].includes(tag)));
    if (plan.githubReleaseArgs) {
      assert.ok(plan.githubReleaseArgs.includes("--prerelease"));
      assert.ok(plan.githubReleaseArgs.includes("--latest=false"));
    }
  });
}
test("explicit stable dispatch permits stable pointers only on a final version tag", () => {
  const plan = releasePlan({ eventName: "workflow_dispatch", ref: "refs/tags/v2.2.4", channel: "stable", sha });
  assert.equal(plan.prerelease, false);
  assert.ok(plan.imageTags.includes("stable"));
  assert.ok(plan.imageTags.includes("latest"));
  assert.ok(plan.githubReleaseArgs.includes("--latest"));
});
test("stable cannot be inferred from push, main, or a preview version", () => {
  for (const values of [{ eventName: "push", ref: "refs/tags/v2.2.4" }, { eventName: "workflow_dispatch", ref: "refs/heads/main" }, { eventName: "workflow_dispatch", ref: "refs/tags/v2.2.4-preview.1" }]) {
    assert.throws(() => releasePlan({ ...values, channel: "stable", sha }), /Stable requires/);
  }
});
test("invalid metadata fails before publication and v2.2.3 cannot be reclassified", () => {
  for (const values of [{ ref: "refs/tags/v2.2.3" }, { ref: "refs/tags/v2.2.2" }, { ref: "refs/tags/v1.9.9" }, { ref: "refs/tags/v2.2.3-preview.1" }, { ref: "refs/tags/vbad,latest" }, { ref: "refs/tags/v2.2.4\nlatest" }, { ref: "refs/tags/v2.02.4" }, { ref: `refs/tags/v${"9".repeat(129)}.0.0`, channel: "stable", eventName: "workflow_dispatch" }, { ref: "refs/heads/main", channel: "beta" }, { ref: "refs/heads/main", sha: "bad" }]) {
    assert.throws(() => releasePlan({ sha, ...values }));
  }
});
test("workflow consumes the checked channel plan and disables implicit latest", () => {
  const workflow = readFileSync(new URL("../.github/workflows/docker-publish.yml", import.meta.url), "utf8");
  assert.match(workflow, /default: preview/);
  assert.match(workflow, /node scripts\/release-plan\.mjs --github-output/);
  assert.match(workflow, /latest=false/);
  assert.match(workflow, /tags: \$\{\{ steps\.channel\.outputs\.metadata_tags \}\}/);
  assert.ok(!workflow.includes("enable={{is_default_branch}}"));
  assert.ok(!workflow.includes("type=ref,event=tag"));
});
test("actual CLI writes only isolated preview metadata to GITHUB_OUTPUT", () => {
  const dir = mkdtempSync(join(tmpdir(), "hydrogen-release-plan-"));
  try {
    const output = join(dir, "output");
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("./release-plan.mjs", import.meta.url)), "--github-output"], {
      encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v2.2.4", GITHUB_SHA: sha, RELEASE_CHANNEL: "preview", GITHUB_OUTPUT: output },
    });
    assert.equal(run.status, 0, run.stderr);
    const metadata = readFileSync(output, "utf8");
    assert.ok(metadata.includes("channel=preview\n"));
    assert.ok(metadata.includes("type=raw,value=preview-v2.2.4\n"));
    assert.ok(!metadata.includes("type=raw,value=latest"));
    assert.ok(!metadata.includes("type=raw,value=stable"));
    assert.ok(JSON.parse(run.stdout).githubReleaseArgs.includes("--latest=false"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("CLI rejects unsafe channels and historical/overlong tags without changing output", () => {
  const dir = mkdtempSync(join(tmpdir(), "hydrogen-release-plan-"));
  try {
    const output = join(dir, "output");
    for (const [ref, event, channel] of [["refs/tags/v2.2.3", "push", "preview"], ["refs/tags/v2.2.2", "workflow_dispatch", "stable"], ["refs/heads/main", "workflow_dispatch", "stable"], ["refs/tags/v2.2.4-preview.1", "workflow_dispatch", "stable"], [`refs/tags/v${"9".repeat(96)}.0.0`, "workflow_dispatch", "stable"]]) {
      writeFileSync(output, "untouched\n");
      const run = spawnSync(process.execPath, [fileURLToPath(new URL("./release-plan.mjs", import.meta.url)), "--github-output"], {
        encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: sha, RELEASE_CHANNEL: channel, GITHUB_OUTPUT: output },
      });
      assert.equal(run.status, 1);
      assert.equal(readFileSync(output, "utf8"), "untouched\n");
    }
    const exact = releasePlan({ ref: `refs/tags/v${"9".repeat(95)}.0.0`, eventName: "workflow_dispatch", channel: "stable", sha });
    assert.equal(exact.imageTags[0].length, 100);
    assert.ok(exact.imageTags.every(tag => tag.length <= 128));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
