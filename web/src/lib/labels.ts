/** Display strings several pages compose the same way. */

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** A client key in a picker: its name and the visible start of the key. */
export const tokenLabel = (token: { name: string; keyPrefix: string }): string => `${token.name} · ${token.keyPrefix}`;

/** `label`, marked "(disabled)" when the thing it names is switched off. */
export const withDisabledNote = (label: string, enabled: boolean, t: Translate): string =>
  enabled ? label : `${label} (${t("common.disabled")})`;

/** A duration with its unit ("120 ms"). Pass an already formatted number to group digits. */
export const msLabel = (ms: number | string, t: Translate): string => `${ms} ${t("common.ms")}`;
