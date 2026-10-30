import { Check, MessageCircleQuestion, MessageCircleX, Plug } from "lucide-react";
import { m } from "motion/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useIdentity } from "@/hooks/useIdentity";
import { api } from "@/lib/api";
import {
  EMPTY_DRAFT,
  buildAnswers,
  canSubmit,
  firstOpenGroup,
  nextOpenGroup,
  parseNumber,
  questionGroups,
  setBool,
  setText,
  summarizeAnswers,
  toggleOther,
  togglePick,
  type QuestionDraft,
  type QuestionGroup,
  type QuestionItem,
} from "@/lib/question";
import type { Agent } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { useQuestionUi } from "@/store/questionUi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Spinner } from "../ui/misc";

const RESOLUTION_LABEL: Record<string, string> = { answered: "Answered", skipped: "Skipped", cancelled: "Cancelled" };

export const questionCardSelector = (requestId: string) => `[data-question-request="${CSS.escape(requestId)}"]`;

/** Sends the answers (or skips); resolves false after a toast when the backend refused. */
export async function answerQuestion(
  agentId: string,
  item: QuestionItem,
  answers: Parameters<typeof api.answerQuestion>[2],
): Promise<boolean> {
  try {
    await api.answerQuestion(agentId, item.requestId, answers);
    return true;
  } catch (e) {
    toast.error("Couldn't send your answer", { description: errorMessage(e) });
    return false;
  }
}

/** Where an agent's question came from, for the header ("From MCP server · github"). */
function sourceLabel(source: string): string {
  return /^from\b/i.test(source) ? source : `From MCP server · ${source}`;
}

export const QuestionCard = memo(function QuestionCard({
  item,
  agent,
  compact,
  keyboard,
}: {
  item: QuestionItem;
  agent: Agent;
  compact?: boolean;
  /** Number keys, arrows and Enter act on this card (the latest pending one in the visible agent). */
  keyboard?: boolean;
}) {
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const draft = useQuestionUi((s) => s.drafts[item.requestId]) ?? EMPTY_DRAFT;
  const groups = useMemo(() => questionGroups(item.fields), [item.fields]);
  const [busy, setBusy] = useState<"submit" | "skip" | null>(null);
  const [active, setActive] = useState(() => firstOpenGroup(groups, draft));
  // Highlighted option per field (arrow keys); options.length is the "Other" row.
  const [cursor, setCursor] = useState<Record<string, number>>({});
  const cardRef = useRef<HTMLDivElement>(null);
  const pendingNow = item.resolution === null;
  const multi = groups.length > 1;
  const update = (fn: (d: QuestionDraft) => QuestionDraft) => useQuestionUi.getState().update(item.requestId, fn);
  const ready = canSubmit(item.fields, draft);

  // Keys only act while the card is on screen.
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !keyboard || !pendingNow) return;
    const id = item.requestId;
    const io = new IntersectionObserver(
      ([entry]) => useQuestionUi.getState().setVisible(id, entry.isIntersecting && entry.intersectionRatio > 0.25),
      { threshold: [0, 0.25, 0.5] },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      useQuestionUi.getState().setVisible(id, false);
    };
  }, [keyboard, pendingNow, item.requestId]);
  // Forget the draft once answered.
  useEffect(() => {
    if (!pendingNow) useQuestionUi.getState().clear(item.requestId);
  }, [pendingNow, item.requestId]);

  const submit = async () => {
    if (busy || !ready) return;
    setBusy("submit");
    const ok = await answerQuestion(agent.id, item, buildAnswers(item.fields, draft));
    if (!ok) setBusy(null);
  };
  const skip = async () => {
    if (busy) return;
    setBusy("skip");
    const ok = await answerQuestion(agent.id, item, null);
    if (!ok) setBusy(null);
  };

  // `advance`: a number key on a single choice settles the question, so move on to the next one.
  const pick = (gi: number, index: number, advance = false) => {
    const g = groups[gi];
    const options = g.field.options ?? [];
    setActive(gi);
    setCursor((c) => ({ ...c, [g.field.id]: index }));
    if (index < options.length) {
      update((d) => togglePick(d, g, options[index].value));
      if (advance && g.field.kind === "single" && gi < groups.length - 1) setActive(gi + 1);
    } else if (g.other) {
      update((d) => (d.otherOn[g.field.id] && g.field.kind === "single" ? d : toggleOther(d, g)));
    }
  };

  const chooseBool = (gi: number, value: boolean) => {
    update((d) => setBool(d, groups[gi].field.id, value));
    setActive(gi < groups.length - 1 ? gi + 1 : gi);
  };

  // Enter: on to the next unanswered question; only the last one (or Ctrl/Cmd+Enter) submits, so a
  // reflexive Enter after a number key can't send a half-answered card. `refocus`: Enter in a text box.
  const enter = (from: number, force: boolean, refocus = false) => {
    if (force || from >= groups.length - 1) return void submit();
    const n = nextOpenGroup(groups, draft, from + 1);
    const to = n < 0 ? groups.length - 1 : n;
    setActive(to);
    if (!refocus) return;
    requestAnimationFrame(() => {
      const f = groups[to].field;
      const input =
        f.kind === "text" || f.kind === "number"
          ? cardRef.current?.querySelector<HTMLElement>(`[data-field-id="${CSS.escape(f.id)}"] input`)
          : null;
      if (input) input.focus();
      else if (cardRef.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    });
  };

  // Latest values for the window key handler.
  const live = useRef({ groups, draft, active, cursor, ready, busy, pick, chooseBool, enter, submit });
  live.current = { groups, draft, active, cursor, ready, busy, pick, chooseBool, enter, submit };
  useEffect(() => {
    if (!keyboard || !pendingNow) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey && e.key !== "Enter") || e.altKey || e.defaultPrevented || e.isComposing || e.keyCode === 229)
        return;
      if (!useQuestionUi.getState().visible[item.requestId]) return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]',
        )
      )
        return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const inCard = Boolean(t && cardRef.current?.contains(t));
      const typing = Boolean(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
      const s = live.current;
      const g = s.groups[s.active];
      const options = g?.field.options ?? [];
      const rows = options.length + (g?.other ? 1 : 0);
      // Where the highlight is: the arrow cursor, else the picked option (single).
      const cur = g
        ? (s.cursor[g.field.id] ?? options.findIndex((o) => s.draft.picks[g.field.id]?.includes(o.value)))
        : -1;
      const rowOn = (i: number) =>
        i < options.length
          ? Boolean(s.draft.picks[g.field.id]?.includes(options[i].value))
          : Boolean(s.draft.otherOn[g.field.id]);
      const force = e.ctrlKey || e.metaKey;
      if (e.key === "Enter" && (force || (!e.shiftKey && (typing ? inCard : !t?.closest("button, a, [role=menu]"))))) {
        if (e.repeat) return;
        e.preventDefault();
        // Enter on a highlighted single-choice option that isn't chosen yet chooses it.
        if (!force && g?.field.kind === "single" && cur >= 0 && cur < rows && !rowOn(cur)) s.pick(s.active, cur);
        else s.enter(s.active, force);
        return;
      }
      if (e.ctrlKey || typing || e.repeat) return;
      // Other focus targets (buttons elsewhere, links) keep their own keys; a focused control in the
      // card handles Space itself.
      if (t && !inCard && t.closest("button, a, [role=menuitem]")) return;
      if (e.key === " " && t?.closest("button, a, [role=checkbox], [role=radio]")) return;
      if (!g) return;
      if (/^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (g.field.kind === "boolean") {
          if (i < 2) {
            e.preventDefault();
            s.chooseBool(s.active, i === 0);
          }
        } else if (i < rows) {
          e.preventDefault();
          s.pick(s.active, i, true);
        }
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && rows > 0 && g.field.kind !== "text") {
        // Arrows only move the highlight; choosing is Space / Enter / a number key.
        e.preventDefault();
        const next = Math.max(0, Math.min(rows - 1, cur + (e.key === "ArrowDown" ? 1 : -1)));
        setCursor((c) => ({ ...c, [g.field.id]: next }));
      } else if (e.key === " " && cur >= 0 && rows > 0) {
        e.preventDefault();
        s.pick(s.active, cur);
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        setActive((a) => Math.max(0, Math.min(s.groups.length - 1, a + (e.key === "ArrowRight" ? 1 : -1))));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyboard, pendingNow, item.requestId]);

  if (!pendingNow) return <ResolvedQuestion item={item} />;

  const single = !multi ? groups[0] : null;
  const activeKind = groups[active]?.field.kind;
  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      ref={cardRef}
      role="group"
      data-question-request={item.requestId}
      aria-label={`Question from ${identity.short}: ${item.message}`}
      className="relative overflow-hidden rounded-2xl border border-warn/40 bg-gradient-to-b from-warn/[0.09] to-card shadow-[0_0_0_1px_color-mix(in_srgb,var(--warn)_10%,transparent),0_12px_40px_-16px_color-mix(in_srgb,var(--warn)_45%,transparent)] edge"
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-warn/70 to-transparent" />
      <div className="flex items-start gap-3 px-4 pb-3 pt-3.5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-warn/40 bg-warn/15 text-warn">
          <MessageCircleQuestion className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-warn">
            <span>{identity.short} has a question</span>
            {item.source && (
              <span className="flex min-w-0 items-center gap-1 font-medium normal-case tracking-normal text-steel">
                <Plug className="h-3 w-3 shrink-0" />
                <span className="truncate">{sourceLabel(item.source)}</span>
              </span>
            )}
          </div>
          <div
            className={cn("mt-0.5 break-words text-fg", multi ? "text-[13px] text-muted" : "text-[14px] font-medium")}
          >
            {item.message}
          </div>
        </div>
      </div>

      <div className={cn("space-y-4 px-4 pb-3.5", compact && "space-y-3")}>
        {groups.map((g, gi) => (
          <FieldBlock
            key={g.field.id}
            group={g}
            draft={draft}
            // A lone question's text is already the heading.
            hideDescription={single !== null && g.field.description === item.message}
            multi={multi}
            keys={Boolean(keyboard) && gi === active}
            dim={multi && gi !== active && Boolean(keyboard)}
            cursor={cursor[g.field.id]}
            disabled={busy !== null}
            onFocus={() => setActive(gi)}
            onPick={(i) => pick(gi, i)}
            onText={(id, text) => update((d) => setText(d, id, text))}
            onBool={(id, v) => update((d) => setBool(d, id, v))}
            onEnter={(force) => enter(gi, force, true)}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-warn/15 bg-base/30 px-4 py-3">
        <Button
          size="sm"
          variant="warn"
          disabled={busy !== null || !ready}
          onClick={() => void submit()}
          aria-keyshortcuts={keyboard ? "Enter" : undefined}
        >
          {busy === "submit" ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Check />}
          Submit
          {keyboard && <Kbd className="ml-0.5 border-current/25 bg-transparent text-current opacity-75">↵</Kbd>}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void skip()}>
          {busy === "skip" ? <Spinner className="h-3.5 w-3.5 text-current" /> : null}
          Skip
        </Button>
        {keyboard && (
          <span className="ml-auto hidden items-center gap-1.5 text-[11px] text-steel sm:flex">
            {activeKind === "boolean" && (
              <>
                <Kbd>1</Kbd> Yes <Kbd>2</Kbd> No
              </>
            )}
            {(activeKind === "single" || activeKind === "multi") && (
              <>
                <Kbd>1</Kbd>–<Kbd>9</Kbd> pick <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> move
              </>
            )}
            {multi && (
              <>
                <Kbd>←</Kbd>
                <Kbd>→</Kbd> question
              </>
            )}
          </span>
        )}
      </div>
    </m.div>
  );
});

function FieldBlock({
  group,
  draft,
  hideDescription,
  multi,
  keys,
  dim,
  cursor,
  disabled,
  onFocus,
  onPick,
  onText,
  onBool,
  onEnter,
}: {
  group: QuestionGroup;
  draft: QuestionDraft;
  hideDescription: boolean;
  multi: boolean;
  /** Number keys act on this field. */
  keys: boolean;
  dim: boolean;
  cursor: number | undefined;
  disabled: boolean;
  onFocus: () => void;
  onPick: (index: number) => void;
  onText: (id: string, text: string) => void;
  onBool: (id: string, value: boolean) => void;
  /** Enter in a text box. */
  onEnter: (force: boolean) => void;
}) {
  const { field, other } = group;
  const options = field.options ?? [];
  const picked = draft.picks[field.id] ?? [];
  const otherOn = Boolean(draft.otherOn[field.id]);
  const otherRef = useRef<HTMLInputElement>(null);
  // Focus the box when the user turns "Other" on, not when a saved draft remounts with it on.
  const wasOtherOn = useRef(otherOn);
  useEffect(() => {
    if (otherOn && !wasOtherOn.current) otherRef.current?.focus();
    wasOtherOn.current = otherOn;
  }, [otherOn]);
  const showHeader = field.title || (field.description && !hideDescription) || field.required;
  const choice = field.kind === "single" || field.kind === "multi";
  const numberText = draft.texts[field.id] ?? "";
  const badNumber = field.kind === "number" && numberText.trim() !== "" && parseNumber(numberText) === null;

  return (
    <div
      data-field-id={field.id}
      className={cn("space-y-2 transition-opacity", dim && "opacity-70")}
      onFocusCapture={onFocus}
      onPointerDown={onFocus}
    >
      {showHeader && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {field.title && (
              <span className="rounded-md border border-warn/30 bg-warn/10 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-warn">
                {field.title}
              </span>
            )}
            {field.kind === "multi" && <span className="text-[11px] text-steel">Select all that apply</span>}
            {field.required && <span className="text-[11px] text-steel">Required</span>}
          </div>
          {field.description && !hideDescription && (
            <div
              className={cn("break-words", multi ? "text-[13.5px] font-medium text-fg" : "text-[12.5px] text-muted")}
            >
              {field.description}
            </div>
          )}
        </div>
      )}

      {choice && (
        <div
          role={field.kind === "single" ? "radiogroup" : "group"}
          aria-label={field.title ?? field.description ?? undefined}
          className="space-y-1.5"
        >
          {options.map((o, i) => (
            <OptionRow
              key={o.value}
              label={o.label}
              description={o.description}
              multi={field.kind === "multi"}
              selected={picked.includes(o.value)}
              focused={keys && cursor === i}
              hint={keys && i < 9 ? String(i + 1) : null}
              disabled={disabled}
              onClick={() => onPick(i)}
            />
          ))}
          {other && (
            <>
              <OptionRow
                label="Other…"
                description={null}
                multi={field.kind === "multi"}
                selected={otherOn}
                focused={keys && cursor === options.length}
                hint={keys && options.length < 9 ? String(options.length + 1) : null}
                disabled={disabled}
                onClick={() =>
                  otherOn && field.kind === "single" ? otherRef.current?.focus() : onPick(options.length)
                }
              />
              {otherOn && (
                <Input
                  ref={otherRef}
                  value={draft.texts[other.id] ?? ""}
                  disabled={disabled}
                  placeholder={other.description || other.title || "Type your answer"}
                  aria-label={`${field.title ?? "Answer"}: other`}
                  onChange={(e) => onText(other.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") e.currentTarget.blur();
                  }}
                  className="ml-7 w-[calc(100%-1.75rem)]"
                />
              )}
            </>
          )}
        </div>
      )}

      {field.kind === "text" && (
        <Input
          type={field.secret ? "password" : "text"}
          autoComplete={field.secret ? "off" : undefined}
          value={draft.texts[field.id] ?? ""}
          disabled={disabled}
          aria-label={field.title ?? field.description ?? field.id}
          onChange={(e) => onText(field.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onEnter(e.ctrlKey || e.metaKey);
            }
          }}
        />
      )}
      {field.kind === "number" && (
        <>
          <Input
            type="text"
            inputMode="decimal"
            value={draft.texts[field.id] ?? ""}
            disabled={disabled}
            aria-invalid={badNumber || undefined}
            aria-describedby={badNumber ? `${field.id}-nan` : undefined}
            aria-label={field.title ?? field.description ?? field.id}
            onChange={(e) => onText(field.id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onEnter(e.ctrlKey || e.metaKey);
              }
            }}
            className="max-w-48 tabular"
          />
          {badNumber && (
            <div id={`${field.id}-nan`} role="alert" className="text-[11.5px] text-err">
              Not a number
            </div>
          )}
        </>
      )}
      {field.kind === "boolean" && (
        <div role="radiogroup" aria-label={field.title ?? field.description ?? field.id} className="flex gap-2">
          {[true, false].map((v) => (
            <button
              key={String(v)}
              type="button"
              role="radio"
              aria-checked={draft.bools[field.id] === v}
              disabled={disabled}
              onClick={() => onBool(field.id, v)}
              className={cn(
                "h-9 min-w-20 rounded-lg border px-4 text-[13px] font-medium transition-colors disabled:opacity-50",
                draft.bools[field.id] === v
                  ? "border-warn/60 bg-warn/15 text-fg"
                  : "border-line bg-base/40 text-muted hover:border-line-strong hover:text-fg",
              )}
            >
              {v ? "Yes" : "No"}
              {keys && <Kbd className="ml-2">{v ? "1" : "2"}</Kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function OptionRow({
  label,
  description,
  multi,
  selected,
  focused,
  hint,
  disabled,
  onClick,
}: {
  label: string;
  description?: string | null;
  multi: boolean;
  selected: boolean;
  focused: boolean;
  hint: string | null;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      aria-keyshortcuts={hint ?? undefined}
      className={cn(
        "group flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-60",
        selected
          ? "border-warn/55 bg-warn/[0.12]"
          : "border-line bg-base/40 hover:border-line-strong hover:bg-raised/60",
        focused && !selected && "border-warn/35",
        focused && "ring-2 ring-warn/25",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border transition-colors",
          multi ? "rounded-[5px]" : "rounded-full",
          selected ? "border-warn bg-warn text-warn-fg" : "border-line-strong text-transparent",
        )}
        aria-hidden
      >
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium text-fg">{label}</span>
        {description && <span className="mt-0.5 block text-[12px] leading-snug text-muted">{description}</span>}
      </span>
      {hint && <Kbd className="mt-0.5 shrink-0">{hint}</Kbd>}
    </button>
  );
}

function ResolvedQuestion({ item }: { item: QuestionItem }) {
  const summary = useMemo(() => summarizeAnswers(item), [item]);
  const answered = item.resolution === "answered";
  const cancelled = item.resolution === "cancelled";
  const Icon = answered ? MessageCircleQuestion : MessageCircleX;
  return (
    <div className="px-1.5 text-[12.5px]">
      <div className="flex h-8 items-center gap-2">
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border",
            answered ? "border-ok/25 bg-ok/10 text-ok" : "border-line text-steel",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-muted">{item.message}</span>
        <span className={cn("shrink-0 text-[11.5px] font-medium", answered ? "text-ok" : "text-steel")}>
          {RESOLUTION_LABEL[item.resolution ?? ""] ?? (cancelled ? "Cancelled" : "Answered")}
        </span>
      </div>
      {answered && summary.length > 0 && (
        <dl className="ml-8 space-y-1 pb-1.5">
          {summary.map((s) => (
            <div key={s.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <dt className="text-[11.5px] text-steel">{s.title}:</dt>
              <dd className="flex flex-wrap gap-1">
                {s.chips.map((c, i) => (
                  <span
                    key={i}
                    className={cn(
                      "rounded-md border px-1.5 py-px text-[11.5px] font-medium",
                      c.custom ? "border-line-strong bg-raised text-fg italic" : "border-warn/35 bg-warn/10 text-fg",
                    )}
                  >
                    {c.text}
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
