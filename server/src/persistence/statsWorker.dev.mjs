// Source-mode only. Production ships the bundled CJS worker without tsx.
import { register } from "tsx/esm/api";
register();
await import("./statsWorker.ts");
