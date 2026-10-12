import type { AgentCondition, AgentContextBlock, AgentStage, AgentTransition } from "../types";
import { patchAt } from "./collections";

/** Names, tables and pure operations of a Micro Agent's stages. */

/** Value of the "runs" select for a stage that calls no model and only routes. */
export const ROUTER = "__router__";

/** The `goto` target that ends the run instead of naming a stage. */
export const GOTO_END = "end";

/** A stage's `tools` setting: absent = inherit the agent's tools, "none" = only the ones it lists. */
export const TOOLS_MODE = { inherit: "inherit", none: "none" } as const;

/** The two roles a context block can speak as. */
export const BLOCK_ROLES = ["user", "assistant"] as const;
export type BlockRole = (typeof BLOCK_ROLES)[number];

export type BlockKind = AgentContextBlock["kind"];

interface BlockSpec {
  /** i18n key of the kind's name (the row's badge and its menu entry). */
  labelKey: string;
  /** i18n key of the line under a row of this kind, for the kinds that need explaining. */
  hintKey?: string;
  /** A fresh block of this kind; `earlier` are the names of the stages before this one. */
  create: (earlier: readonly string[]) => AgentContextBlock;
}

/** Every context block kind, in menu order. */
export const CONTEXT_BLOCKS: Record<BlockKind, BlockSpec> = {
  original_conversation: {
    labelKey: "contextBlock.originalConversation",
    hintKey: "blockHint.originalConversation",
    create: () => ({ kind: "original_conversation" }),
  },
  text_conversation: {
    labelKey: "contextBlock.textConversation",
    hintKey: "blockHint.textConversation",
    create: () => ({ kind: "text_conversation" }),
  },
  last_user: { labelKey: "contextBlock.lastUser", hintKey: "blockHint.lastUser", create: () => ({ kind: "last_user" }) },
  last_user_text: { labelKey: "contextBlock.lastUserText", hintKey: "blockHint.lastUserText", create: () => ({ kind: "last_user_text" }) },
  last_user_images: {
    labelKey: "contextBlock.lastUserImages",
    hintKey: "blockHint.lastUserImages",
    create: () => ({ kind: "last_user_images" }),
  },
  stage_output: {
    labelKey: "contextBlock.stageOutput",
    create: (earlier) => ({ kind: "stage_output", stage: earlier[0] ?? "", role: "assistant" }),
  },
  message: { labelKey: "contextBlock.message", create: () => ({ kind: "message", role: "user", text: "" }) },
  tool_turn: { labelKey: "contextBlock.toolTurn", create: () => ({ kind: "tool_turn", name: "", input: "", result: "" }) },
};

export interface BlockMenuEntry {
  /** The option's value. */
  value: string;
  /** The kind of block it adds. */
  kind: BlockKind;
  labelKey: string;
}

/**
 * The "add context block" menu: one entry per kind, plus "Plain text", a
 * second way to add a `message` block (audit W-B-03: two menu entries, one
 * behaviour -- kept, removing a menu entry is a visible change).
 */
export const CONTEXT_BLOCK_MENU: readonly BlockMenuEntry[] = [
  ...(Object.keys(CONTEXT_BLOCKS) as BlockKind[]).map((kind) => ({ value: kind, kind, labelKey: CONTEXT_BLOCKS[kind].labelKey })),
  { value: "plain_text", kind: "message", labelKey: "contextBlock.plainText" },
];

/** The block a menu entry adds (an unknown value adds the original conversation). */
export function newContextBlock(value: string, earlier: readonly string[]): AgentContextBlock {
  const kind = CONTEXT_BLOCK_MENU.find((entry) => entry.value === value)?.kind ?? "original_conversation";
  return CONTEXT_BLOCKS[kind].create(earlier);
}

type ConditionType = AgentCondition["type"];

/** Every transition condition, in menu order, with the i18n key of its name. */
export const CONDITIONS: readonly { type: ConditionType; labelKey: string }[] = [
  { type: "always", labelKey: "condition.always" },
  { type: "input_has_image", labelKey: "condition.inputHasImage" },
  { type: "input_contains", labelKey: "condition.inputContains" },
  { type: "input_matches", labelKey: "condition.inputMatches" },
  { type: "output_contains", labelKey: "condition.outputContains" },
  { type: "output_matches", labelKey: "condition.outputMatches" },
];

/** The condition compares against a text the user types. */
export const condHasValue = (c: Pick<AgentCondition, "type">): boolean => c.type.endsWith("_contains") || c.type.endsWith("_matches");
/** The condition looks at a stage's output (and so can name which stage). */
export const condIsOutput = (c: Pick<AgentCondition, "type">): boolean => c.type === "output_contains" || c.type === "output_matches";
/** The condition's text is a regular expression rather than a substring. */
export const condIsRegex = (c: Pick<AgentCondition, "type">): boolean => c.type.endsWith("matches");

/** A fresh condition of `type`: an empty text for the ones that compare, nothing else. */
export const newCondition = (type: ConditionType): AgentCondition => (condHasValue({ type }) ? { type, value: "" } : { type }) as AgentCondition;

/** A stage that calls a model: through a referenced service, or through legacy inline steps. */
export const isModelStage = (s: Pick<AgentStage, "service" | "steps">): boolean => !!s.service || !!(s.steps && s.steps.length);

/** Something that references a service still carries the inline steps it had before services existed. */
export const hasLegacyInlineSteps = (x: Pick<AgentStage, "service" | "steps">): boolean => !x.service && !!(x.steps && x.steps.length);

/** The number appended to the first duplicate of a stage name ("draft" -> "draft2"). */
const FIRST_DUPLICATE_SUFFIX = 2;

/** `base`, or `base` + the first number from 2 that makes it a name no stage has. */
export function uniqueName(stages: readonly AgentStage[], base: string): string {
  const taken = new Set(stages.map((s) => s.name));
  if (!taken.has(base)) return base;
  for (let i = FIRST_DUPLICATE_SUFFIX; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}

/** Name of a stage nobody named yet. */
const NEW_STAGE_NAME = "stage";
/** What is appended to the name of a duplicated stage. */
const COPY_SUFFIX = "_copy";

/** A new stage for the end of `stages`, running `service` when there is one to run. */
export const newStage = (stages: readonly AgentStage[], service: string | undefined): AgentStage => ({
  name: uniqueName(stages, NEW_STAGE_NAME),
  input: [],
  ...(service ? { service } : {}),
});

/** A deep copy of `stage` under a name of its own ("draft" -> "draft_copy" -> "draft_copy2"). */
export function duplicateStage(stages: readonly AgentStage[], stage: AgentStage): AgentStage {
  const copy = JSON.parse(JSON.stringify(stage)) as AgentStage;
  copy.name = uniqueName(stages, `${stage.name}${COPY_SUFFIX}`);
  return copy;
}

/** A stage name as typed: whitespace is not allowed, so it becomes underscores. */
export const stageNameFromInput = (raw: string): string => raw.replace(/\s+/g, "_");

/** Whether a stage other than the one at `index` is named `name`. */
const nameTaken = (stages: readonly AgentStage[], index: number, name: string): boolean => stages.some((s, i) => i !== index && s.name === name);

/**
 * `stages` and the agent's `output` with every reference to the stage name
 * `from` pointing at `to`: `stage_output` blocks, the stage an output
 * condition looks at, a transition's target and the output an "end" transition
 * returns. Stage names themselves are not touched, and neither is the reserved
 * target "end".
 */
export function renameStageRefs(stages: readonly AgentStage[], output: string, from: string, to: string): { stages: AgentStage[]; output: string } {
  const transition = (tr: AgentTransition): AgentTransition => ({
    ...tr,
    ...("stage" in tr.when && tr.when.stage === from ? { when: { ...tr.when, stage: to } } : {}),
    ...(tr.goto === from && from !== GOTO_END ? { goto: to } : {}),
    ...(tr.output === from ? { output: to } : {}),
  });
  return {
    stages: stages.map((s) => ({
      ...s,
      input: s.input.map((b) => (b.kind === "stage_output" && b.stage === from ? { ...b, stage: to } : b)),
      ...(s.transitions ? { transitions: s.transitions.map(transition) } : {}),
    })),
    output: output === from ? to : output,
  };
}

export interface StageRename {
  stages: AgentStage[];
  output: string;
  /**
   * The name the references to this stage still carry, while its own name
   * cannot identify it (empty, or another stage's). Pass it back with the next
   * rename of the same stage; undefined once the references follow the name.
   */
  pending: string | undefined;
}

/**
 * The stage at `index` renamed to `name`, taking the references to it along.
 * References are by name, so they move only between two names that each
 * identify this stage alone: while the box is empty, or holds the name of
 * another stage (typing "check2" passes through "check"), they keep the last
 * such name (`pending`) and are repointed once the typed name is unique again.
 * References to a name the stage shared with another one are left alone.
 */
export function renameStage(stages: readonly AgentStage[], output: string, index: number, name: string, pending: string | undefined): StageRename {
  const from = pending ?? stages[index].name;
  const renamed = patchAt(stages, index, { name });
  if (!name || nameTaken(stages, index, name)) return { stages: renamed, output, pending: from || undefined };
  if (!from || from === name || nameTaken(stages, index, from)) return { stages: renamed, output, pending: undefined };
  return { ...renameStageRefs(renamed, output, from, name), pending: undefined };
}
