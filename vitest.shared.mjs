import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

/** Resolve @areelai/* to package sources so tests never need a build step. */
export const areelaiAliases = [
  { find: /^@areelai\/([a-z-]+)\/(.+)$/, replacement: path.join(root, "packages", "$1", "src", "$2.ts") },
  { find: /^@areelai\/([a-z-]+)$/, replacement: path.join(root, "packages", "$1", "src", "index.ts") },
];
