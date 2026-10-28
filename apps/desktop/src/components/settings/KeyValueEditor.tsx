import { Eye, EyeOff, Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import type { KeyValue } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface KeyValueRow extends KeyValue {
  /** Stable React key for rows being edited. */
  key: string;
}

/** Per-row validation error, keyed by row key. */
export type KeyValueErrors = Record<string, string>;

/**
 * Validates rows: completely empty rows are ignored; a value without a name,
 * an invalid name, or a duplicate name is an error.
 */
export function validateKeyValues(rows: KeyValueRow[], namePattern: RegExp, patternHint: string): KeyValueErrors {
  const errors: KeyValueErrors = {};
  const seen = new Map<string, string>();
  for (const r of rows) {
    const name = r.name.trim();
    if (!name && !r.value) continue;
    if (!name) {
      errors[r.key] = "Add a name for this value.";
      continue;
    }
    if (!namePattern.test(name)) {
      errors[r.key] = patternHint;
      continue;
    }
    const norm = name.toLowerCase();
    if (seen.has(norm)) errors[r.key] = `“${name}” is already set above.`;
    else seen.set(norm, r.key);
  }
  return errors;
}

/** Rows ready to persist: trimmed names, empty rows dropped. */
export function cleanKeyValues(rows: KeyValueRow[]): KeyValue[] {
  return rows.filter((r) => r.name.trim() || r.value).map((r) => ({ name: r.name.trim(), value: r.value }));
}

export function KeyValueEditor({
  label,
  rows,
  onChange,
  errors,
  showErrors,
  namePlaceholder,
  valuePlaceholder,
  addLabel,
  newKey,
}: {
  label: string;
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  errors: KeyValueErrors;
  showErrors: boolean;
  namePlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  newKey: () => string;
}) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  // Focus the name field of a row the user just added.
  const [added, setAdded] = useState<string | null>(null);

  const update = (key: string, patch: Partial<KeyValue>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <div role="group" aria-label={label}>
      {rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((r) => {
            const err = showErrors ? errors[r.key] : undefined;
            const shown = revealed[r.key] ?? false;
            return (
              <li key={r.key}>
                <div className="flex items-center gap-2">
                  <Input
                    autoFocus={r.key === added}
                    value={r.name}
                    onChange={(e) => update(r.key, { name: e.target.value })}
                    placeholder={namePlaceholder}
                    aria-label={`${label} name`}
                    aria-invalid={!!err}
                    className={cn(
                      "h-8 w-[38%] font-mono text-[12px]",
                      err && "border-err/60 focus:border-err/70 focus:ring-err/15",
                    )}
                  />
                  <div className="relative min-w-0 flex-1">
                    <Input
                      value={r.value}
                      type={shown ? "text" : "password"}
                      autoComplete="off"
                      onChange={(e) => update(r.key, { value: e.target.value })}
                      placeholder={valuePlaceholder}
                      aria-label={`${r.name || label} value`}
                      className="h-8 pr-8 font-mono text-[12px]"
                    />
                    <Tooltip content={shown ? "Hide value" : "Show value"}>
                      <button
                        type="button"
                        aria-label={shown ? "Hide value" : "Show value"}
                        aria-pressed={shown}
                        onClick={() => setRevealed((v) => ({ ...v, [r.key]: !shown }))}
                        className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-steel transition-colors hover:bg-raised hover:text-fg"
                      >
                        {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </Tooltip>
                  </div>
                  <Tooltip content="Remove">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove ${r.name || "row"}`}
                      onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
                      className="hover:text-err"
                    >
                      <X className="!h-3.5 !w-3.5" />
                    </Button>
                  </Tooltip>
                </div>
                {err && (
                  <p role="alert" className="mt-1 text-[12px] text-err">
                    {err}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={cn("-ml-2", rows.length > 0 && "mt-1.5")}
        onClick={() => {
          const key = newKey();
          setAdded(key);
          onChange([...rows, { key, name: "", value: "" }]);
        }}
      >
        <Plus className="!h-3.5 !w-3.5" /> {addLabel}
      </Button>
    </div>
  );
}
