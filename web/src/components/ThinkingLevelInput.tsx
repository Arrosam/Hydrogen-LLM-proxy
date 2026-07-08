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
  compact,
}: {
  value: ThinkingLevel | undefined;
  onChange: (v: ThinkingLevel | undefined) => void;
  hint?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div>
      <label className="label">
        Thinking level {hint && <span className="normal-case text-ink-500">{hint}</span>}
      </label>
      <div className="flex items-center gap-2">
        <select
          className={`input ${compact ? "h-8 py-0 text-xs" : "mt-0"}`}
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
            className={`input ${compact ? "h-8 w-28 py-0 text-xs" : "mt-2 w-40"}`}
            type="text"
            inputMode="numeric"
            value={value.budget}
            onFocus={selectAll}
            onClick={selectAll}
            onChange={(e) => onChange({ budget: intInput(e.target.value, 8192, 1024) })}
            placeholder="token budget"
          />
        )}
      </div>
    </div>
  );
}
