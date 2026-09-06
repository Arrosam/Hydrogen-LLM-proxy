/**
 * The dashboard's two translation maps must stay in step.
 *
 * A missing key is invisible in review and nearly invisible in use: `t()` falls
 * back to the English string, so a half-translated feature looks finished to
 * anyone testing in English and shows raw English to everyone else. This lives
 * in the server suite because it is the only suite the repo has, and it needs
 * nothing but the file's text -- no DOM, no React, no new dependency.
 *
 * It also pins the keys the tools feature added, so deleting one from a single
 * map is caught rather than shipped.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const WEB_SRC = path.resolve(__dirname, "../../web/src");
const I18N = path.join(WEB_SRC, "lib", "i18n.tsx");

/** Every `"key":` at the top level of one map literal, in order (duplicates kept). */
function mapKeys(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name}: Dict = {`);
  expect(start, `${name} map not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n};", start);
  expect(end, `${name} map is unterminated`).toBeGreaterThan(start);
  const body = source.slice(start, end);
  return [...body.matchAll(/^ {2}"((?:[^"\\]|\\.)*)":/gm)].map((m) => m[1]);
}

/** Every .ts/.tsx file under web/src. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("web console translations", () => {
  const source = fs.readFileSync(I18N, "utf8");
  const en = mapKeys(source, "en");
  const zh = mapKeys(source, "zh");

  it("declares each key exactly once per map", () => {
    // A repeated key in an object literal silently wins or loses depending on
    // order, so one of the two strings is dead and nobody can tell which.
    const dupes = (keys: string[]) => keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes(en)).toEqual([]);
    expect(dupes(zh)).toEqual([]);
  });

  it("has the same key set in en and zh", () => {
    const inZh = new Set(zh);
    const inEn = new Set(en);
    expect(en.filter((k) => !inZh.has(k))).toEqual([]);
    expect(zh.filter((k) => !inEn.has(k))).toEqual([]);
  });

  it("resolves every literal key the console asks for", () => {
    const known = new Set(en);
    // `t("x")` and `i18n("x")`, including inside a ternary: t(cond ? "a" : "b").
    const CALL = /\b(?:t|i18n)\(\s*([^)]*?)\)/g;
    const LITERAL = /"((?:[^"\\]|\\.)*)"/g;
    const missing: string[] = [];

    for (const file of sources(WEB_SRC)) {
      if (file === I18N) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const call of text.matchAll(CALL)) {
        for (const lit of call[1].matchAll(LITERAL)) {
          const key = lit[1];
          // Only strings shaped like a key; a t() argument can also be a plain
          // interpolation value, and template keys are covered below.
          if (!/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+)+$/.test(key)) continue;
          if (!known.has(key)) missing.push(`${path.relative(WEB_SRC, file)}: ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("resolves the tools feature's template keys for every enum value", () => {
    // These are built as t(`tools.kind.${tool.kind}`) and friends, so the plain
    // scan above cannot see them. The values come from the server's own unions.
    const templated = [
      ...["freeform", "vocabulary"].map((k) => `tools.kind.${k}`),
      ...["freeform", "vocabulary"].map((k) => `tools.field.kind.hint.${k}`),
      ...["prefer_provider", "override"].map((p) => `tools.policy.${p}`),
    ];
    const known = new Set(en);
    expect(templated.filter((k) => !known.has(k))).toEqual([]);
  });
});
