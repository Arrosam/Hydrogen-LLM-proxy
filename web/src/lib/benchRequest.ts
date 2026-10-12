/** The request bodies and endpoints the Model Bench aims at a model. */
import { CHAT_ENDPOINTS, MEDIA_ENDPOINTS, type MediaCategory } from "./serviceDef";
import type { EncodedFile } from "./files";
import { isChatPipelineCategory, type Family, type ServiceCategory } from "../types";

/** `max_tokens` of an Anthropic-shaped request (the field is mandatory there). */
const ANTHROPIC_MAX_TOKENS = 4096;
/** `anthropic-version` header sent with an Anthropic-shaped proxy request. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** The client endpoint a category (and, for chat, an ingress family) lives on. */
export function proxyPath(category: ServiceCategory, ingress: Family): string {
  if (isChatPipelineCategory(category)) return CHAT_ENDPOINTS[ingress];
  return MEDIA_ENDPOINTS[category as MediaCategory] ?? CHAT_ENDPOINTS.openai_completion;
}

/** One attachment as the content part its wire family spells it with. */
function attachmentPart(a: EncodedFile, family: Family): Record<string, unknown> {
  const isImage = a.mediaType.startsWith("image/");
  if (family === "anthropic") {
    return isImage
      ? { type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } }
      : { type: "document", title: a.name, source: { type: "base64", media_type: a.mediaType, data: a.data } };
  }
  if (family === "openai_responses") {
    return isImage
      ? { type: "input_image", image_url: a.dataUrl }
      : { type: "input_file", filename: a.name, file_data: a.dataUrl };
  }
  return isImage
    ? { type: "image_url", image_url: { url: a.dataUrl } }
    : { type: "file", file: { filename: a.name, file_data: a.dataUrl } };
}

export interface ChatInput {
  model: string;
  family: Family;
  system: string;
  text: string;
  attachments: EncodedFile[];
  stream: boolean;
  params: Record<string, unknown>;
}

/** The wire body a client of `family` would send. */
export function buildChatBody(i: ChatInput): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [];
  if (i.family === "openai_responses") {
    if (i.text) parts.push({ type: "input_text", text: i.text });
  } else {
    parts.push({ type: "text", text: i.text });
  }
  for (const a of i.attachments) parts.push(attachmentPart(a, i.family));

  if (i.family === "anthropic") {
    return {
      model: i.model,
      // Required on this wire and deliberately not invented anywhere else in
      // Hydrogen, so the bench states it like a real Anthropic client would.
      max_tokens: ANTHROPIC_MAX_TOKENS,
      ...(i.system ? { system: i.system } : {}),
      messages: [{ role: "user", content: parts }],
      ...(i.stream ? { stream: true } : {}),
      ...i.params,
    };
  }
  if (i.family === "openai_responses") {
    return {
      model: i.model,
      ...(i.system ? { instructions: i.system } : {}),
      input: [{ role: "user", content: parts }],
      ...(i.stream ? { stream: true } : {}),
      ...i.params,
    };
  }
  return {
    model: i.model,
    messages: [
      ...(i.system ? [{ role: "system", content: i.system }] : []),
      { role: "user", content: parts },
    ],
    ...(i.stream ? { stream: true } : {}),
    ...i.params,
  };
}

/** A starting body for each media category, so the panel is never a blank box. */
export function defaultMediaBody(category: ServiceCategory, model: string, text: string): Record<string, unknown> {
  switch (category) {
    case "embedding": return { model, input: text || "hello" };
    case "rerank": return { model, query: text || "hello", documents: ["first document", "second document"] };
    case "image": return { model, prompt: text || "a red circle on a white background", n: 1, size: "1024x1024" };
    case "video": return { model, prompt: text || "a red circle rolling across a white background" };
    case "tts": return { model, input: text || "Hydrogen model bench.", voice: "alloy" };
    case "stt": return { model };
    default: return { model };
  }
}
