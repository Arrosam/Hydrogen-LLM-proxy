/**
 * Bootstrap-icon class names that identify an entity or an action wherever it
 * appears (nav link, page header, empty state, modal title, cross-reference).
 */

export const ENTITY_ICON = {
  overview: "bi-speedometer2",
  service: "bi-diagram-3",
  microAgent: "bi-robot",
  tool: "bi-tools",
  model: "bi-box",
  provider: "bi-hdd-network",
  proxy: "bi-shuffle",
  token: "bi-key",
  bench: "bi-clipboard-pulse",
  log: "bi-journal-text",
  activeRequest: "bi-activity",
  user: "bi-people",
  check: "bi-search",
  settings: "bi-gear",
  mapping: "bi-diagram-2",
} as const;

export const ACTION_ICON = {
  add: "bi-plus-lg",
  save: "bi-check-lg",
  close: "bi-x-lg",
  edit: "bi-pencil",
  /** The delete glyph everywhere except the Proxies cards. */
  remove: "bi-trash3",
  removeAlt: "bi-trash",
  revoke: "bi-x-circle",
  duplicate: "bi-files",
  copy: "bi-clipboard",
  test: "bi-plug",
  signOut: "bi-box-arrow-right",
  /** Shown in place of a button's icon while its action runs. */
  busy: "bi-arrow-repeat animate-spin",
  refresh: "bi-arrow-clockwise",
  live: "bi-broadcast",
  external: "bi-box-arrow-up-right",
} as const;
