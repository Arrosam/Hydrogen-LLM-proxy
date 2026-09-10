// Bundle the gateway into one CJS file. Workspace packages are inlined; the
// runtime dependencies listed in package.json stay external and are installed
// in the image's runtime stage.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/server.cjs",
  external: Object.keys(pkg.dependencies ?? {}),
  tsconfig: "tsconfig.json",
  logLevel: "info",
  // A dropped bare import means a package registered nothing at load time (the
  // wire formats, for one); the bundle would start and fail on the first request.
  logOverride: { "ignored-bare-import": "error" },
});
