import { MessageSquare, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn, modKey } from "@/lib/utils";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import type { LineAnchor } from "../DiffView";
import type { LineComment } from "./commentStore";

/** Inline editor under a diff line. Ctrl/⌘+Enter saves, Esc cancels (without closing the sheet). */
export function LineCommentEditor({
  anchor,
  initial = "",
  onSave,
  onCancel,
}: {
  anchor: LineAnchor;
  initial?: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const save = () => {
    if (text.trim()) onSave(text.trim());
  };
  return (
    <div className="space-y-2" data-comment-editor>
      <div className="flex items-center gap-1.5 text-[11.5px] text-steel">
        <MessageSquare className="h-3.5 w-3.5" />
        <span className="font-mono">
          {anchor.path}:{anchor.line}
          {anchor.side === "old" && " (removed)"}
        </span>
      </div>
      <textarea
        ref={ref}
        value={text}
        aria-label={`Comment on ${anchor.path} line ${anchor.line}`}
        placeholder="What should the agent change here?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            // Keep the Review sheet open: Esc only cancels this editor.
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        rows={3}
        className="block w-full resize-y rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] leading-relaxed text-fg placeholder:text-steel focus:border-accent/60 focus:outline-none focus:ring-3 focus:ring-accent/15"
      />
      <div className="flex items-center gap-2">
        <span className="mr-auto hidden items-center gap-1 text-[11px] text-steel sm:flex">
          <Kbd>{modKey}</Kbd>
          <Kbd>⏎</Kbd> save <span className="mx-1 text-line-strong">·</span> <Kbd>Esc</Kbd> cancel
        </span>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={!text.trim()} onClick={save}>
          {initial ? "Save" : "Add comment"}
        </Button>
      </div>
    </div>
  );
}

export function LineCommentCard({
  comment,
  onEdit,
  onDelete,
  outdated = false,
  className,
}: {
  comment: LineComment;
  /** Omitted for comments whose line left the diff (they can only be deleted). */
  onEdit?: () => void;
  onDelete: () => void;
  /** The line changed (or vanished) since the comment was written. */
  outdated?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "group/comment flex items-start gap-2.5 rounded-lg border border-warn/30 bg-warn/[0.06] px-3 py-2",
        className,
      )}
    >
      <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-steel">
          <span>
            {comment.path}:{comment.line}
            {comment.side === "old" && " (removed)"}
          </span>
          {outdated && (
            <span
              title="The code at this line changed since you commented; it's sent with the line as you saw it."
              className="rounded border border-line-strong px-1 font-sans text-[10px] font-medium text-muted"
            >
              Outdated
            </span>
          )}
        </div>
        <p className="selectable mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg">
          {comment.text}
        </p>
      </div>
      <div className="flex shrink-0 gap-0.5">
        {onEdit && (
          <Button size="icon-xs" variant="ghost" aria-label="Edit comment" onClick={onEdit}>
            <Pencil className="!h-3 !w-3" />
          </Button>
        )}
        <Button size="icon-xs" variant="ghost" aria-label="Delete comment" onClick={onDelete}>
          <Trash2 className="!h-3 !w-3" />
        </Button>
      </div>
    </div>
  );
}
