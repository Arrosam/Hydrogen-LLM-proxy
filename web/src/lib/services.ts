import type { ModelService } from "../types";
import { isAgentDef, isChatPipelineCategory, serviceCategoryOf } from "../types";

/** Which services a Micro Agent's parts may reference. */

/** Every service but `self`: a service cannot reference itself. */
export const otherServices = (services: readonly ModelService[], self: ModelService | null): ModelService[] =>
  services.filter((m) => m.id !== self?.id);

/** Micro Agents. */
export const agentServices = (services: readonly ModelService[]): ModelService[] => services.filter((m) => isAgentDef(m.steps));

/**
 * Model Services that run the chat pipeline (chat and ocr). The media
 * passthrough categories (image/tts/embedding/...) cannot run inside an agent.
 */
export const chatServices = (services: readonly ModelService[]): ModelService[] =>
  services.filter((m) => !isAgentDef(m.steps) && isChatPipelineCategory(serviceCategoryOf(m.steps)));

/** Speech-to-text Model Services, the only kind the ASR pre-pass can drive. */
export const sttServices = (services: readonly ModelService[]): ModelService[] =>
  services.filter((m) => !isAgentDef(m.steps) && serviceCategoryOf(m.steps) === "stt");

/** What a stage of a Micro Agent can run: every service the "runs" select offers (its two groups), in list order. */
export const stageServices = (services: readonly ModelService[]): ModelService[] =>
  services.filter((m) => isAgentDef(m.steps) || isChatPipelineCategory(serviceCategoryOf(m.steps)));
