import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../src");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Tailwind emits a component class from index.css only when its full name
 * appears literally somewhere in the scanned source. A shared component that
 * assembles the name (`btn-${variant}`) passes every DOM test -- the class is
 * on the element -- while the production CSS silently loses the rule.
 */
describe("component classes survive Tailwind's content scan", () => {
  const css = fs.readFileSync(path.join(SRC, "index.css"), "utf8");
  // A base class the others build on with `@apply` (`.btn`) is never put on an
  // element itself, so it has no reason to appear in the source.
  const applied = new Set([...css.matchAll(/@apply\s+([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
  const defined = [...css.matchAll(/^\s*\.([a-z][a-z0-9-]*)\s*\{/gm)].map((m) => m[1]).filter((name) => !applied.has(name));
  const source = sourceFiles(SRC)
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");

  it("finds the component classes in index.css", () => {
    expect(defined).toContain("btn-primary");
    expect(defined.length).toBeGreaterThan(5);
  });

  it.each(defined)("%s is written out in full in the source", (name) => {
    expect(source).toMatch(new RegExp(`(?<![A-Za-z0-9-])${name}(?![A-Za-z0-9-])`));
  });
});
