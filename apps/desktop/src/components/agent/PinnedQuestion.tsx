import { ArrowLeft, ArrowRight, Check, ChevronsDownUp, MessageCircleQuestion, Plug } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useIdentity } from "@/hooks/useIdentity";
import { shouldIgnoreApprovalKey } from "@/lib/approvalKeys";
import { quickKeyIndex } from "@/lib/pinned";
import {
  EMPTY_DRAFT,
  boolAnswers,
  buildAnswers,
  canSubmit,
  firstOpenGroup,
  pickAnswers,
  questionHeadline,
  questionShape,
  setBool,
  setText,
  toggleOther,
  togglePick,
  type QuestionDraft,
  type QuestionGroup,
  type QuestionItem,
} from "@/lib/question";
import type { Agent, QuestionAnswers } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useQuestionUi } from "@/store/questionUi";
import { useUi } from "@/store/ui";
import { FieldBlock, answerQuestion } from "../timeline/QuestionCard";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Spinner } from "../ui/misc";

/** Long enough that two lines of the headline may cut it off. */
const LONG_HEADLINE = 120;

/**
 * The question the agent is waiting on, as the "needs you" row of the pinned dock. A single question
 * with a few options is answered with one click (or a number key); a multi-select with checkboxes and
 * "Send answer"; anything bigger opens a step-by-step form right here. Answers go through the same
 * draft store, answer building and `answerQuestion` as the card in the timeline.
 */
export function QuestionSection({
  agent,
  item,
  focused = true,
  compact = false,
}: {
  agent: Agent;
  item: QuestionItem;
  focused?: boolean;
  compact?: boolean;
}) {
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const requestId = item.requestId;
  const draft = useQuestionUi((s) => s.drafts[requestId]) ?? EMPTY_DRAFT;
  const shape = useMemo(() => questionShape(item.fields), [item.fields]);
  const [busy, setBusy] = useState<"send" | "skip" | string | null>(null);
  const [more, setMore] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [step, setStep] = useState(0);
  const otherRef = useRef<HTMLInputElement>(null);
  const update = (fn: (d: QuestionDraft) => QuestionDraft) => useQuestionUi.getState().update(requestId, fn);
  const headline = questionHeadline(item);
  const quick = shape.mode !== "stepper";
  const formVisible = shape.mode === "stepper" && formOpen;

  // While this row answers with the number keys, the card in the timeline leaves them alone.
  useEffect(() => {
    if (!quick && !formVisible) return;
    useQuestionUi.getState().setDocked(requestId, true);
    return () => useQuestionUi.getState().setDocked(requestId, false);
  }, [requestId, quick, formVisible]);

  // A ref as well as the state: the number-key handler below keeps the `send` of an earlier render,
  // whose `busy` is stale, so two quick presses would otherwise both answer.
  const sending = useRef(false);
  const send = async (answers: QuestionAnswers | null, key: string) => {
    if (busy || sending.current) return;
    sending.current = true;
    setBusy(key);
    const ok = await answerQuestion(agent.id, item, answers);
    if (ok) useQuestionUi.getState().clear(requestId);
    else {
      sending.current = false;
      setBusy(null);
    }
  };

  const group = shape.mode === "stepper" ? null : shape.group;
  const options = group?.field.options ?? [];
  const otherOn = group ? Boolean(draft.otherOn[group.field.id]) : false;
  const rows = options.length + (group?.other ? 1 : 0);
  const ready = canSubmit(item.fields, draft);

  const toggleOtherRow = () => {
    if (!group) return;
    update((d) => (group.field.kind === "single" && d.otherOn[group.field.id] ? d : toggleOther(d, group)));
  };
  const pick = (i: number) => {
    if (!group) return;
    if (i >= options.length) return toggleOtherRow();
    if (group.field.kind === "single") {
      // One click settles it, unless the user has "Other" open: then it replaces what they were typing.
      const answers = pickAnswers(item.fields, 0, i);
      if (answers) void send(answers, `opt:${i}`);
    } else {
      update((d) => togglePick(d, group, options[i].value));
    }
  };
  const submitDraft = () => {
    if (ready) void send(buildAnswers(item.fields, draft), "send");
  };

  // Number keys (never while typing: the same guard as the approval keys).
  const live = useRef({ shape, rows, pick, send: submitDraft });
  live.current = { shape, rows, pick, send: submitDraft };
  useEffect(() => {
    if (!quick || !focused) return;
    const onKey = (e: KeyboardEvent) => {
      const s = live.current;
      if (shouldIgnoreApprovalKey(e)) return;
      if (s.shape.mode === "bool") {
        const i = quickKeyIndex(e, 2);
        if (i === null) return;
        e.preventDefault();
        const answers = boolAnswers(item.fields, 0, i === 0);
        if (answers) void send(answers, `opt:${i}`);
        return;
      }
      const i = quickKeyIndex(e, s.rows);
      if (i === null) return;
      e.preventDefault();
      s.pick(i);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `send` and `item.fields` are stable for the life of this request.
  }, [quick, focused, requestId]);

  // Focus the "Other" box when the user turns it on.
  const wasOtherOn = useRef(otherOn);
  useEffect(() => {
    if (otherOn && !wasOtherOn.current) otherRef.current?.focus();
    wasOtherOn.current = otherOn;
  }, [otherOn]);

  const reveal = () => useUi.getState().revealItem(agent.id, item.id);
  const longHeadline = headline.length > LONG_HEADLINE;
  const groups = shape.mode === "stepper" ? shape.groups : [];
  const hint = focused && !compact;

  return (
    <div role="group" aria-label={`Question from ${identity.short}: ${headline}`} data-question-dock>
      <div className="flex items-start gap-3 px-3.5 pb-2 pt-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-warn/40 bg-warn/15 text-warn">
          <MessageCircleQuestion className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-x-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-warn">
            <span className="shrink-0">{identity.short} has a question</span>
            {item.source && (
              <span className="flex min-w-0 items-center gap-1 font-medium normal-case tracking-normal text-steel">
                <Plug className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{item.source}</span>
              </span>
            )}
            {shape.mode === "multi" && (
              <span className="shrink-0 font-medium normal-case tracking-normal text-steel">Select all that apply</span>
            )}
          </div>
          {longHeadline ? (
            <button
              type="button"
              aria-expanded={more}
              title={more ? "Show less" : "Show the whole question"}
              onClick={() => setMore((v) => !v)}
              className={cn(
                "mt-0.5 block w-full rounded text-left text-[13.5px] font-medium leading-snug text-fg focus-visible:outline-offset-2",
                !more && "line-clamp-2",
              )}
            >
              {headline}
            </button>
          ) : (
            <div className="mt-0.5 break-words text-[13.5px] font-medium leading-snug text-fg">{headline}</div>
          )}
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={reveal}
          aria-label="Show the full question in the conversation"
          title="Show in conversation"
        >
          <ChevronsDownUp />
        </Button>
      </div>

      {group && group.field.kind !== "boolean" && (
        <div className="px-3.5 pb-3">
          <div role="group" aria-label={group.field.title ?? "Choices"} className="flex flex-wrap gap-1.5">
            {options.map((o, i) => (
              <ChoiceButton
                key={o.value}
                label={o.label}
                title={o.description ?? undefined}
                hint={hint ? String(i + 1) : null}
                multi={group.field.kind === "multi"}
                selected={draft.picks[group.field.id]?.includes(o.value) ?? false}
                busy={busy === `opt:${i}`}
                disabled={busy !== null}
                onClick={() => pick(i)}
              />
            ))}
            {group.other && (
              <ChoiceButton
                label="Other…"
                hint={hint ? String(options.length + 1) : null}
                multi={group.field.kind === "multi"}
                selected={otherOn}
                ghost
                disabled={busy !== null}
                onClick={() =>
                  otherOn && group.field.kind === "single" ? otherRef.current?.focus() : pick(options.length)
                }
              />
            )}
            {group.field.kind === "multi" && (
              <Button
                size="sm"
                variant="warn"
                disabled={busy !== null || !ready}
                onClick={submitDraft}
                className="ml-auto"
              >
                {busy === "send" ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Check />}
                Send answer
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void send(null, "skip")}
              className={cn(group.field.kind !== "multi" && "ml-auto")}
            >
              {busy === "skip" ? <Spinner className="h-3.5 w-3.5 text-current" /> : null}
              Skip
            </Button>
          </div>
          {group.other && otherOn && (
            <OtherBox
              inputRef={otherRef}
              group={group}
              draft={draft}
              disabled={busy !== null}
              busy={busy === "send"}
              ready={ready}
              multi={group.field.kind === "multi"}
              onText={(text) => update((d) => setText(d, group.other!.id, text))}
              onSend={submitDraft}
              onCancel={() => update((d) => toggleOther(d, group))}
            />
          )}
        </div>
      )}

      {group && group.field.kind === "boolean" && (
        <div className="flex flex-wrap items-center gap-1.5 px-3.5 pb-3">
          {[true, false].map((v, i) => (
            <ChoiceButton
              key={String(v)}
              label={v ? "Yes" : "No"}
              hint={hint ? String(i + 1) : null}
              multi={false}
              selected={false}
              busy={busy === `opt:${i}`}
              disabled={busy !== null}
              onClick={() => {
                const answers = boolAnswers(item.fields, 0, v);
                if (answers) void send(answers, `opt:${i}`);
              }}
            />
          ))}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void send(null, "skip")}
            className="ml-auto"
          >
            Skip
          </Button>
        </div>
      )}

      {shape.mode === "stepper" &&
        (formOpen ? (
          <Stepper
            groups={groups}
            item={item}
            draft={draft}
            step={Math.min(step, groups.length - 1)}
            busy={busy}
            ready={ready}
            onStep={setStep}
            onSend={submitDraft}
            onSkip={() => void send(null, "skip")}
            onClose={() => setFormOpen(false)}
            update={update}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2 px-3.5 pb-3">
            <Button
              size="sm"
              variant="warn"
              onClick={() => {
                setStep(firstOpenGroup(groups, draft));
                setFormOpen(true);
              }}
            >
              {groups.length > 1 ? `Answer ${groups.length} questions` : "Answer"}
              <ArrowRight />
            </Button>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void send(null, "skip")}>
              {busy === "skip" ? <Spinner className="h-3.5 w-3.5 text-current" /> : null}
              Skip
            </Button>
          </div>
        ))}
    </div>
  );
}

/** A quick-answer button: the option's label with its number key. */
function ChoiceButton({
  label,
  title,
  hint,
  multi,
  selected,
  ghost,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  title?: string;
  hint: string | null;
  multi: boolean;
  selected: boolean;
  ghost?: boolean;
  busy?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={multi ? "checkbox" : undefined}
      aria-checked={multi ? selected : undefined}
      aria-pressed={!multi && ghost ? selected : undefined}
      aria-keyshortcuts={hint ?? undefined}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 max-w-full items-center gap-2 rounded-lg border px-3 text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        selected
          ? "border-warn/60 bg-warn/15 text-fg"
          : ghost
            ? "border-dashed border-line-strong bg-transparent text-muted hover:border-warn/50 hover:text-fg"
            : "border-line-strong bg-raised text-fg hover:border-warn/50 hover:bg-warn/10",
      )}
    >
      {multi && (
        <span
          aria-hidden
          className={cn(
            "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
            selected ? "border-warn bg-warn text-warn-fg" : "border-line-strong text-transparent",
          )}
        >
          <Check className="h-2.5 w-2.5" strokeWidth={3} />
        </span>
      )}
      {busy ? <Spinner className="h-3.5 w-3.5 text-current" /> : null}
      <span className="min-w-0 truncate">{label}</span>
      {hint && <Kbd className="shrink-0">{hint}</Kbd>}
    </button>
  );
}

/** The free-text "Other" answer, typed right in the dock. */
function OtherBox({
  inputRef,
  group,
  draft,
  disabled,
  busy,
  ready,
  multi,
  onText,
  onSend,
  onCancel,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  group: QuestionGroup;
  draft: QuestionDraft;
  disabled: boolean;
  busy: boolean;
  ready: boolean;
  multi: boolean;
  onText: (text: string) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  const other = group.other!;
  return (
    <form
      className="mt-2 flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
    >
      <Input
        ref={inputRef}
        value={draft.texts[other.id] ?? ""}
        disabled={disabled}
        placeholder={other.description || other.title || "Type your answer"}
        aria-label={`${group.field.title ?? "Answer"}: other`}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        className="min-w-0 flex-1"
      />
      {!multi && (
        <Button type="submit" size="sm" variant="warn" disabled={disabled || !ready}>
          {busy ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Check />}
          Send
        </Button>
      )}
    </form>
  );
}

/** Several questions (or a form), one at a time, inside the dock. */
function Stepper({
  groups,
  item,
  draft,
  step,
  busy,
  ready,
  onStep,
  onSend,
  onSkip,
  onClose,
  update,
}: {
  groups: QuestionGroup[];
  item: QuestionItem;
  draft: QuestionDraft;
  step: number;
  busy: string | null;
  ready: boolean;
  onStep: (step: number) => void;
  onSend: () => void;
  onSkip: () => void;
  onClose: () => void;
  update: (fn: (d: QuestionDraft) => QuestionDraft) => void;
}) {
  const g = groups[step];
  const last = step >= groups.length - 1;
  const many = groups.length > 1;
  return (
    <div className="border-t border-warn/15 bg-base/30 px-3.5 pt-2.5">
      {many && (
        <div className="mb-2 flex items-center gap-2 text-[11.5px] text-steel">
          <span className="tabular">
            Question {step + 1} of {groups.length}
          </span>
          <span className="flex items-center gap-1" aria-hidden>
            {groups.map((x, i) => (
              <span
                key={x.field.id}
                className={cn("h-1 w-4 rounded-full transition-colors", i <= step ? "bg-warn" : "bg-line-strong")}
              />
            ))}
          </span>
        </div>
      )}
      {g && (
        <FieldBlock
          key={g.field.id}
          group={g}
          draft={draft}
          hideDescription={!many && g.field.description === item.message}
          multi={many}
          keys={false}
          dim={false}
          dense
          cursor={undefined}
          disabled={busy !== null}
          onFocus={() => {}}
          onPick={(i) => {
            const options = g.field.options ?? [];
            if (i < options.length) update((d) => togglePick(d, g, options[i].value));
            else if (g.other)
              update((d) => (d.otherOn[g.field.id] && g.field.kind === "single" ? d : toggleOther(d, g)));
          }}
          onText={(id, text) => update((d) => setText(d, id, text))}
          onBool={(id, v) => update((d) => setBool(d, id, v))}
          onEnter={(force) => (force || last ? onSend() : onStep(step + 1))}
        />
      )}
      <div className="sticky bottom-0 -mx-3.5 mt-2 flex flex-wrap items-center gap-2 border-t border-warn/15 bg-card px-3.5 py-2.5">
        {many && step > 0 && (
          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => onStep(step - 1)}>
            <ArrowLeft />
            Back
          </Button>
        )}
        {last ? (
          <Button size="sm" variant="warn" disabled={busy !== null || !ready} onClick={onSend}>
            {busy === "send" ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Check />}
            {many ? "Send answers" : "Send answer"}
          </Button>
        ) : (
          <Button size="sm" variant="warn" disabled={busy !== null} onClick={() => onStep(step + 1)}>
            Next
            <ArrowRight />
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={onSkip}>
          {busy === "skip" ? <Spinner className="h-3.5 w-3.5 text-current" /> : null}
          Skip
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto" disabled={busy !== null} onClick={onClose}>
          Collapse
        </Button>
      </div>
    </div>
  );
}
