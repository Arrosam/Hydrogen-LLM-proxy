// Source mode only; production ships the bundled CJS worker without tsx.
import { register } from "tsx/esm/api";
register();
await import("./responsePruneWorker.ts");
