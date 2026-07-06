import type { ReactNode } from "react";
import type { ThinkingLevel } from "../types";
import { intInput, selectAll } from "../lib/input";

const LEVELS = ["disabled", "auto", "enabled", "low", "medium", "high", "xhigh", "max"] as const;

/** The "Thinking level" select + optional token-budget input shared by the
 * Model Service step editor and the Micro Agent stage editor. */
export function ThinkingLevelInput({
  value,
  onChange,
  hint,
}: {
  value: ThinkingLevel | undefined;
  onChange: (v: ThinkingLevel | undefined) => void;
  hint?: ReactNode;
}) {
  return (
    <div>
      <label className="label">
        Thinking level {hint && <span className="normal-case text-ink-500">{hint}</span>}
      </label>
      <select
        className="input"
        value={value ? (typeof value === "object" ? "budget" : value) : ""}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) onChange(undefined);
          else if (v === "budget") onChange({ budget: 8192 });
          else onChange(v as (typeof LEVELS)[number]);
        }}
      >
        <option value="">inherit (from request)</option>
        {LEVELS.map((l) => (
          <option key={l} value={l}>{l}</option>
        ))}
        <option value="budget">budget (tokens)</option>
      </select>
      {value && typeof value === "object" && (
        <input
          className="input mt-2"
          type="text"
          inputMode="numeric"
          value={value.budget}
          onFocus={selectAll}
          onClick={selectAll}
          onChange={(e) => onChange({ budget: intInput(e.target.value, 8192, 1024) })}
          placeholder="token budget (min 1024)"
        />
      )}
    </div>
  );
}
