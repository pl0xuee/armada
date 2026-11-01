import { memo, useEffect, useState } from "react";
import { answerQuestion } from "@/lib/controller";
import { cn } from "@/lib/cn";
import { quickAnswers, quickQuestion } from "@/lib/dock";
import { useStore } from "@/lib/store";
import type { QuestionItem } from "@/lib/types";
import { Icon, Spinner } from "./Icon";
import { Sheet } from "./Sheet";
import { QuestionCard } from "./timeline/Question";
import { Button } from "./ui";

const ROW = "press flex min-h-[52px] w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left disabled:opacity-60";

/**
 * Answers an agent's question with big taps: one tap on a choice (single choice, yes/no), or tap several and
 * press Send (multi). A question that needs more (several fields, free text, "Other") shows one button that
 * opens the full form in a sheet. Used by the dock and by the Needs you queue.
 */
export const QuickAnswer = memo(function QuickAnswer({
  item,
  onOpenForm,
  maxHeight = "34dvh",
}: {
  item: QuestionItem;
  onOpenForm: () => void;
  /** The choices scroll inside this (a long list must not push the dock off a small screen). */
  maxHeight?: string;
}) {
  const quick = quickQuestion(item);
  const sending = useStore((s) => !!s.resolving[item.requestId]);
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => setPicked([]), [item.requestId]);

  if (!quick) {
    return (
      <Button size="lg" variant="primary" icon="chevronRight" className="w-full" onClick={onOpenForm}>
        Answer
      </Button>
    );
  }
  const send = (values: string[]) => void answerQuestion(item.agentId, item.requestId, quickAnswers(quick, values));
  const multi = quick.mode === "multi";
  const bool = quick.mode === "boolean";
  return (
    <div className="space-y-2">
      <div
        role="group"
        aria-label={item.message || "Choices"}
        className={cn("overscroll-contain", bool ? "grid grid-cols-2 gap-2" : "space-y-2 overflow-y-auto")}
        style={bool ? undefined : { maxHeight }}
      >
        {quick.choices.map((c) => {
          const on = picked.includes(c.value);
          return (
            <button
              key={c.value}
              type="button"
              {...(multi ? { role: "checkbox", "aria-checked": on } : {})}
              disabled={sending}
              onClick={() =>
                multi ? setPicked((cur) => (cur.includes(c.value) ? cur.filter((x) => x !== c.value) : [...cur, c.value])) : send([c.value])
              }
              className={cn(
                ROW,
                bool && "justify-center text-[15.5px] font-semibold",
                on ? "border-accent/60 bg-accent/10" : "border-line-strong bg-raised",
              )}
            >
              {multi && (
                <span
                  aria-hidden
                  className={cn(
                    "inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md border-[1.5px]",
                    on ? "border-accent bg-accent text-accent-fg" : "border-line-strong text-transparent",
                  )}
                >
                  <Icon name="check" size={14} strokeWidth={2.5} />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className={cn("block leading-snug break-words text-fg", !bool && "text-[15px] font-medium")}>{c.label}</span>
                {c.description && <span className="mt-0.5 block text-[13px] leading-snug break-words text-muted">{c.description}</span>}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        {multi && (
          <Button
            size="lg"
            variant="primary"
            className="min-w-0 flex-1"
            disabled={sending || (quick.field.required !== false && picked.length === 0)}
            loading={sending}
            onClick={() => send(picked)}
          >
            {picked.length ? `Send ${picked.length}` : "Send"}
          </Button>
        )}
        <button
          type="button"
          onClick={onOpenForm}
          disabled={sending}
          className={cn(
            "press inline-flex h-11 shrink-0 items-center gap-1 rounded-xl px-2 text-[13.5px] font-medium text-muted active:text-fg disabled:opacity-60",
            !multi && "ml-auto",
          )}
        >
          {quick.hasOther ? "Other…" : "Open form"}
          <Icon name="chevronRight" size={16} />
        </button>
        {sending && !multi && <Spinner size={16} className="text-steel" />}
      </div>
    </div>
  );
});

/** The full question form in a sheet; closes itself once the question is answered (`item` becomes null). */
export function QuestionSheet({ item, onClose, title }: { item: QuestionItem | null; onClose: () => void; title: string }) {
  const [shown, setShown] = useState(item);
  useEffect(() => {
    if (item) setShown(item);
  }, [item]);
  const q = item ?? shown;
  return (
    <Sheet open={!!item} onClose={onClose} title="Question" description={title}>
      {q && <QuestionCard item={q} readOnly={false} inSheet />}
    </Sheet>
  );
}
