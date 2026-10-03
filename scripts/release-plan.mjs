import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Produces metadata only. This program never calls GitHub, Docker, or a registry.
export function releasePlan({ eventName = "push", ref, sha, channel = "preview" }) {
  if (channel !== "preview" && channel !== "stable") throw new Error("Release channel must be preview or stable");
  if (!/^[a-f0-9]{40}$/i.test(sha ?? "")) throw new Error("A full commit SHA is required");
  const isTag = typeof ref === "string" && ref.startsWith("refs/tags/");
  const name = typeof ref === "string" ? ref.replace(/^refs\/(heads|tags)\//, "") : "";
  if (!name || !/^refs\/(heads|tags)\//.test(ref)) throw new Error("A branch or tag ref is required");
  const versionTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/.exec(name);
  if (isTag && (!versionTag || name.length > 100)) throw new Error("Version tags must use vMAJOR.MINOR.PATCH with an optional preview suffix, up to 100 characters");
  if (isTag) {
    const core = versionTag.slice(1, 4).map(part => BigInt(part));
    const baseline = [2n, 2n, 3n];
    const changed = core.findIndex((part, index) => part !== baseline[index]);
    if (changed === -1 || core[changed] < baseline[changed]) throw new Error("Existing releases through v2.2.3 are preserved; choose a future release");
  }
  if (channel === "stable" && (eventName !== "workflow_dispatch" || !isTag || !/^v\d+\.\d+\.\d+$/.test(name))) {
    throw new Error("Stable requires explicit workflow dispatch on a final version tag");
  }
  const safeName = name.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 100);
  const imageTags = channel === "stable"
    ? [name, "stable", "latest", `stable-sha-${sha.slice(0, 12)}`]
    : ["preview", `preview-${safeName}`, `preview-sha-${sha.slice(0, 12)}`];
  return {
    channel,
    imageTags,
    metadataTags: imageTags.map(tag => `type=raw,value=${tag}`).join("\n"),
    prerelease: channel === "preview",
    latest: channel === "stable",
    // Future separately-authorized release publication must retain these flags.
    githubReleaseArgs: isTag ? ["release", "create", name, "--verify-tag", ...(channel === "preview" ? ["--prerelease", "--latest=false"] : ["--latest"])] : null,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = name => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
  try {
    const plan = releasePlan({
      eventName: flag("--event") ?? process.env.GITHUB_EVENT_NAME ?? "push",
      ref: flag("--ref") ?? process.env.GITHUB_REF,
      sha: flag("--sha") ?? process.env.GITHUB_SHA,
      channel: flag("--channel") ?? process.env.RELEASE_CHANNEL ?? "preview",
    });
    if (args.includes("--github-output")) {
      if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
      appendFileSync(process.env.GITHUB_OUTPUT, `channel=${plan.channel}\nmetadata_tags<<HYDROGEN_RELEASE_TAGS\n${plan.metadataTags}\nHYDROGEN_RELEASE_TAGS\n`);
    }
    console.log(JSON.stringify(plan, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
