/** Reading files and moving bytes in and out of base64. */

/** Bytes converted per `String.fromCharCode` call: spreading more overflows the argument limit. */
const BASE64_CHUNK = 0x8000;
/** Media type of a file the browser could not identify. */
const UNKNOWN_MEDIA_TYPE = "application/octet-stream";

/** A file held in memory, ready to be put in a request. */
export interface EncodedFile {
  name: string;
  mediaType: string;
  /** base64, without the data: prefix. */
  data: string;
  /** The same bytes as a `data:` URL. Built once, at read time, because three
   * of the four wire spellings want it and there is no reason to re-derive it
   * per send. (Not a hot path: a JS engine ropes a concatenation and only
   * flattens it when the string is consumed, which is at serialization.) */
  dataUrl: string;
}

/** Chunked, because String.fromCharCode(...bytes) blows the argument limit on
 * anything bigger than a small image. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

export const base64ToBytes = (base64: string) => Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));

export const toDataUrl = (mediaType: string, base64: string): string => `data:${mediaType};base64,${base64}`;

export async function readEncodedFile(file: File): Promise<EncodedFile> {
  const mediaType = file.type || UNKNOWN_MEDIA_TYPE;
  const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
  return { name: file.name, mediaType, data, dataUrl: toDataUrl(mediaType, data) };
}
