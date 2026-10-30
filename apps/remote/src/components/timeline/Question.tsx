import { memo, useState } from "react";
import { answerQuestion } from "@/lib/controller";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import {
  buildAnswers,
  canSubmit,
  isChoice,
  otherOf,
  primaryFields,
  problems,
  resolutionText,
  summarize,
  type Draft,
} from "@/lib/question";
import { useStore } from "@/lib/store";
import type { QuestionField, QuestionItem } from "@/lib/types";
import { Icon, Spinner } from "../Icon";
import { Button } from "../ui";

/** Unsent entries survive the card scrolling out of the virtual list. */
const drafts = new Map<string, Draft>();

const INPUT =
  "block h-12 w-full rounded-xl border border-line-strong bg-code px-3.5 text-[16px] text-fg outline-none placeholder:text-steel focus:border-accent/60";

/** The compact read-only view of a question that was answered, skipped or cancelled (or is being sent). */
export function ResolvedQuestion({ item, resolution, pending }: { item: QuestionItem; resolution: string; pending: boolean }) {
  const rows = resolution === "answered" ? summarize(item) : [];
  const label = resolutionText(resolution);
  const color = pending || resolution !== "answered" ? "var(--steel)" : "var(--ok)";
  return (
    <div className="flex min-h-12 items-start gap-3 rounded-2xl border border-line bg-panel px-3 py-2.5 edge">
      <span
        className="mt-px inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
        style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
      >
        {pending ? <Spinner size={14} /> : <Icon name={resolution === "answered" ? "check" : "x"} size={16} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] break-words text-fg/90">{item.message || "Question"}</span>
        <span className="block text-[12.5px] font-medium" style={{ color }}>
          {pending ? (resolution === "skipped" ? "Skipping…" : "Sending your answer…") : label}
        </span>
        {rows.length > 0 && (
          <dl className="mt-1.5 space-y-1">
            {rows.map((r, i) => (
              <div key={i} className="text-[13px] leading-snug break-words">
                {r.label && <dt className="inline text-steel">{r.label}: </dt>}
                <dd className="inline text-fg">{r.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </span>
    </div>
  );
}

function Indicator({ multi, on }: { multi: boolean; on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center border-[1.5px] transition-colors",
        multi ? "rounded-md" : "rounded-full",
        on ? "border-accent bg-accent text-accent-fg" : "border-line-strong text-transparent",
      )}
    >
      {multi ? <Icon name="check" size={14} strokeWidth={2.5} /> : on && <span className="h-2 w-2 rounded-full bg-accent-fg" />}
    </span>
  );
}

function ChoiceRow({
  multi,
  on,
  label,
  description,
  onClick,
  disabled,
}: {
  multi: boolean;
  on: boolean;
  label: string;
  description?: string | null;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "press flex min-h-[52px] w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left disabled:opacity-60",
        on ? "border-accent/60 bg-accent/10" : "border-line-strong bg-raised",
      )}
    >
      <Indicator multi={multi} on={on} />
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] leading-snug font-medium break-words text-fg">{label}</span>
        {description && <span className="mt-0.5 block text-[13px] leading-snug break-words text-muted">{description}</span>}
      </span>
    </button>
  );
}

function BooleanInput({ value, onChange, disabled }: { value: boolean | undefined; onChange: (v: boolean) => void; disabled: boolean }) {
  return (
    <div role="radiogroup" className="grid grid-cols-2 gap-1 rounded-xl border border-line-strong bg-code p-1">
      {([true, false] as const).map((v) => (
        <button
          key={String(v)}
          type="button"
          role="radio"
          aria-checked={value === v}
          disabled={disabled}
          onClick={() => onChange(v)}
          className={cn(
            "press h-11 rounded-[9px] text-[15px] font-medium disabled:opacity-60",
            value === v ? "bg-accent text-accent-fg" : "text-muted",
          )}
        >
          {v ? "Yes" : "No"}
        </button>
      ))}
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  disabled,
  placeholder,
  label,
  autoFocus,
}: {
  field: QuestionField;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  placeholder?: string;
  label: string;
  autoFocus?: boolean;
}) {
  const number = field.kind === "number";
  return (
    <input
      type={field.secret ? "password" : "text"}
      inputMode={number ? "decimal" : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={label}
      autoFocus={autoFocus}
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      autoComplete={field.secret ? "off" : undefined}
      enterKeyHint="done"
      className={cn(INPUT, "disabled:opacity-60")}
    />
  );
}

function FieldBlock({
  fields,
  field,
  draft,
  set,
  disabled,
  single,
  invalid,
}: {
  fields: QuestionField[];
  field: QuestionField;
  draft: Draft;
  set: (id: string, v: Draft[string] | undefined) => void;
  disabled: boolean;
  /** The only field: the message is its heading, so no title chip. */
  single: boolean;
  invalid: boolean;
}) {
  const other = isChoice(field) ? otherOf(fields, field.id) : null;
  const otherText = other && typeof draft[other.id] === "string" ? (draft[other.id] as string) : "";
  const [otherOpen, setOtherOpen] = useState(!!otherText);
  const multi = field.kind === "multi";
  const picked = multi ? (Array.isArray(draft[field.id]) ? (draft[field.id] as string[]) : []) : draft[field.id];
  const title = single ? null : field.title;
  const desc = field.description;

  const toggle = (value: string) => {
    if (multi) {
      const cur = picked as string[];
      set(field.id, cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value]);
    } else if (picked === value) {
      set(field.id, undefined);
    } else {
      set(field.id, value);
      // One answer per single-choice question: picking an option replaces "Other".
      if (other) {
        set(other.id, undefined);
        setOtherOpen(false);
      }
    }
  };
  const toggleOther = () => {
    if (!other) return;
    if (otherOpen) {
      setOtherOpen(false);
      set(other.id, undefined);
    } else {
      setOtherOpen(true);
      if (!multi) set(field.id, undefined);
    }
  };

  return (
    <div className="space-y-2.5" role="group" aria-label={field.title || field.description || field.id}>
      {(title || (desc && !single)) && (
        <div className="space-y-1">
          {title && (
            <span className="inline-block max-w-full rounded-md bg-raised px-2 py-0.5 text-[12px] font-semibold tracking-wide break-words text-muted uppercase">
              {title}
            </span>
          )}
          {desc && <p className="text-[14.5px] leading-snug break-words text-fg">{desc}</p>}
        </div>
      )}
      {single && desc && <p className="text-[13.5px] leading-snug break-words text-muted">{desc}</p>}
      {isChoice(field) ? (
        <div className="space-y-2" role={multi ? "group" : "radiogroup"}>
          {(field.options ?? []).map((o) => (
            <ChoiceRow
              key={o.value}
              multi={multi}
              on={multi ? (picked as string[]).includes(o.value) : picked === o.value}
              label={o.label}
              description={o.description}
              onClick={() => toggle(o.value)}
              disabled={disabled}
            />
          ))}
          {other && (
            <>
              <ChoiceRow multi={multi} on={otherOpen} label="Other…" onClick={toggleOther} disabled={disabled} />
              {otherOpen && (
                <FieldInput
                  field={other}
                  value={otherText}
                  onChange={(v) => {
                    set(other.id, v);
                    if (!multi && v.trim()) set(field.id, undefined);
                  }}
                  disabled={disabled}
                  placeholder="Type your own answer"
                  label={`Other: ${field.title || field.description || field.id}`}
                  autoFocus={!otherText}
                />
              )}
            </>
          )}
        </div>
      ) : field.kind === "boolean" ? (
        <BooleanInput value={typeof draft[field.id] === "boolean" ? (draft[field.id] as boolean) : undefined} onChange={(v) => set(field.id, v)} disabled={disabled} />
      ) : (
        <FieldInput
          field={field}
          value={typeof draft[field.id] === "string" ? (draft[field.id] as string) : ""}
          onChange={(v) => set(field.id, v)}
          disabled={disabled}
          placeholder={field.kind === "number" ? "Enter a number" : "Type your answer"}
          label={field.title || field.description || field.id}
        />
      )}
      {invalid && <p className="text-[12.5px] text-err">{field.kind === "number" && typeof draft[field.id] === "string" && (draft[field.id] as string).trim() ? "Enter a valid number." : "Required."}</p>}
    </div>
  );
}

export const QuestionCard = memo(function QuestionCard({ item, readOnly }: { item: QuestionItem; readOnly: boolean }) {
  const sending = useStore((s) => s.resolving[item.requestId]);
  const now = useNow();
  const [draft, setDraft] = useState<Draft>(() => drafts.get(item.requestId) ?? {});
  const [touched, setTouched] = useState(false);
  if (item.resolution !== null) return <ResolvedQuestion item={item} resolution={item.resolution} pending={false} />;
  if (sending) return <ResolvedQuestion item={item} resolution={sending} pending />;

  const fields = primaryFields(item.fields);
  const single = fields.length === 1;
  const bad = touched ? new Set(problems(item.fields, draft)) : new Set<string>();
  const set = (id: string, v: Draft[string] | undefined) =>
    setDraft((d) => {
      const next = { ...d };
      if (v === undefined) delete next[id];
      else next[id] = v;
      drafts.set(item.requestId, next);
      return next;
    });
  const submit = () => {
    if (!canSubmit(item.fields, draft)) return setTouched(true);
    send(buildAnswers(item.fields, draft));
  };
  const skip = () => send(null);
  // The typed answers are only dropped once the server has them: if sending fails, the card (even
  // after scrolling out of the virtual list and back) still has them to retry.
  function send(answers: Parameters<typeof answerQuestion>[2]) {
    void answerQuestion(item.agentId, item.requestId, answers).then((ok) => {
      if (ok) drafts.delete(item.requestId);
    });
  }

  return (
    <section
      aria-label={`Question: ${item.message}`}
      className="overflow-hidden rounded-2xl border border-warn/45 bg-card shadow-[0_0_0_1px_color-mix(in_srgb,var(--warn)_14%,transparent),0_16px_40px_-18px_color-mix(in_srgb,var(--warn)_50%,transparent)]"
    >
      <div className="flex items-center gap-2 border-b border-warn/15 bg-warn/[0.06] px-4 py-2.5">
        <Icon name="sparkle" size={16} className="text-warn" />
        <span className="text-[12px] font-semibold tracking-wider text-warn uppercase">
          {fields.length > 1 ? "Questions" : "Question"}
          {item.source ? <span className="font-medium tracking-normal normal-case"> · {item.source}</span> : null}
        </span>
        <span className="ml-auto text-[12px] text-steel tabular">{relativeTime(item.ts, now)}</span>
      </div>
      <div className="space-y-4 p-4">
        {item.message && <h3 className="text-[15.5px] leading-snug font-semibold break-words text-fg">{item.message}</h3>}
        {fields.map((f) => (
          <FieldBlock
            key={f.id}
            fields={item.fields}
            field={f}
            draft={draft}
            set={set}
            disabled={readOnly}
            single={single}
            invalid={bad.has(f.id)}
          />
        ))}
        {readOnly ? (
          <p className="flex items-center gap-2 rounded-xl bg-raised px-3 py-2.5 text-[13px] text-muted">
            <Icon name="eye" size={16} className="shrink-0 text-steel" />
            Waiting for the owner to answer.
          </p>
        ) : (
          <div className="grid grid-cols-[1fr_2fr] gap-2 pt-1">
            <Button size="lg" variant="outline" onClick={skip}>
              Skip
            </Button>
            <Button size="lg" variant="primary" onClick={submit} aria-disabled={!canSubmit(item.fields, draft)} className={cn(!canSubmit(item.fields, draft) && "opacity-45")}>
              Submit
            </Button>
          </div>
        )}
      </div>
    </section>
  );
});
