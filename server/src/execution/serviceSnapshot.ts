import type { HttpTool } from "./toolHttp";

/** Feature configuration retained by one saved session. Credentials in tools
 * make this private metadata; ResponseRepo encrypts the complete snapshot. */
export interface SnapshotService {
  id: number;
  name: string;
  enabled: boolean;
  definition: unknown;
  tools: HttpTool[];
}

export interface ServiceSnapshot {
  version: 1;
  rootId: number;
  serverToolNamePrefix: string;
  /** Includes named stages and OCR/ASR services, recursively and without
   * consulting the live service graph when a session continues. */
  services: SnapshotService[];
}
