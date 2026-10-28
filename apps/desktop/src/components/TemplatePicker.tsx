import { ArrowLeft, BookText, CornerDownLeft, Search, Settings2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fillTemplate, placeholderLabel, templatePlaceholders } from "@/lib/templates";
import type { PromptTemplate } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { Button } from "./ui/button";
import { Input, Label } from "./ui/input";
import { Kbd } from "./ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip } from "./ui/tooltip";

/**
 * Prompt-template picker. Templates with {{placeholders}} open a small fill-in form
 * before the text is handed to `onInsert`.
 */
export function TemplatePicker({
  onInsert,
  trigger,
  side = "top",
  align = "start",
}: {
  onInsert: (text: string) => void;
  /** Custom trigger element; defaults to a compact "Templates" button. */
  trigger?: ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  // After inserting (or navigating away), the caller moves focus; don't yank it back to the trigger.
  const keepFocus = useRef(false);
  const templates = useApp((s) => s.settings?.templates ?? []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content="Insert a prompt template">
        <PopoverTrigger asChild>
          {trigger ?? (
            <button
              type="button"
              aria-label="Prompt templates"
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-muted transition-colors hover:bg-raised hover:text-fg data-[state=open]:bg-raised data-[state=open]:text-fg"
            >
              <BookText className="h-3.5 w-3.5" />
              Templates
            </button>
          )}
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        side={side}
        align={align}
        className="w-[360px] p-0"
        onCloseAutoFocus={(e) => {
          if (keepFocus.current) e.preventDefault();
          keepFocus.current = false;
        }}
      >
        {open && (
          <PickerBody
            templates={templates}
            onDone={(text) => {
              keepFocus.current = true;
              setOpen(false);
              onInsert(text);
            }}
            onManage={() => {
              keepFocus.current = true;
              setOpen(false);
              useUi.getState().openSettings("templates");
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function PickerBody({
  templates,
  onDone,
  onManage,
}: {
  templates: PromptTemplate[];
  onDone: (text: string) => void;
  onManage: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [filling, setFilling] = useState<PromptTemplate | null>(null);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? templates.filter((t) => `${t.name} ${t.body}`.toLowerCase().includes(q)) : templates;
  }, [templates, query]);

  useEffect(() => setActive(0), [query]);

  const choose = (t: PromptTemplate) => {
    if (templatePlaceholders(t.body).length > 0) setFilling(t);
    else onDone(t.body);
  };

  if (filling) return <FillForm template={filling} onBack={() => setFilling(null)} onDone={onDone} />;

  return (
    <div className="flex max-h-[420px] flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3">
        <Search className="h-3.5 w-3.5 shrink-0 text-steel" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(list.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter" && list[active]) {
              e.preventDefault();
              choose(list[active]);
            }
          }}
          placeholder="Search templates"
          aria-label="Search templates"
          className="h-10 flex-1 bg-transparent text-[13px] text-fg placeholder:text-steel focus:outline-none"
        />
      </div>
      <ul role="listbox" aria-label="Templates" className="min-h-0 flex-1 overflow-y-auto p-1">
        {list.map((t, i) => {
          const fields = templatePlaceholders(t.body);
          return (
            <li key={t.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(t)}
                className={cn(
                  "flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                  i === active ? "bg-gunmetal/80" : "hover:bg-gunmetal/50",
                )}
              >
                <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
                  {t.name}
                  {fields.length > 0 && (
                    <span className="rounded border border-line-strong px-1 text-[10px] font-normal text-steel">
                      {fields.length} field{fields.length === 1 ? "" : "s"}
                    </span>
                  )}
                </span>
                <span className="line-clamp-2 text-[11.5px] leading-snug text-muted">{t.body}</span>
              </button>
            </li>
          );
        })}
        {list.length === 0 && (
          <li className="px-3 py-8 text-center text-[12.5px] text-steel">
            {templates.length === 0 ? "No templates yet." : "No templates match."}
          </li>
        )}
      </ul>
      <div className="flex items-center justify-between border-t border-line px-3 py-2">
        <span className="flex items-center gap-1 text-[11px] text-steel">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <Kbd>
            <CornerDownLeft className="h-2.5 w-2.5" />
          </Kbd>
        </span>
        <button
          type="button"
          onClick={onManage}
          className="flex items-center gap-1 text-[11.5px] text-muted transition-colors hover:text-fg"
        >
          <Settings2 className="h-3.5 w-3.5" />
          Manage templates
        </button>
      </div>
    </div>
  );
}

function FillForm({
  template,
  onBack,
  onDone,
}: {
  template: PromptTemplate;
  onBack: () => void;
  onDone: (text: string) => void;
}) {
  const fields = useMemo(() => templatePlaceholders(template.body), [template.body]);
  const [values, setValues] = useState<Record<string, string>>({});
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => firstRef.current?.focus(), []);
  const preview = fillTemplate(template.body, values);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onDone(preview);
      }}
      className="flex flex-col"
    >
      <div className="flex items-center gap-2 border-b border-line px-2 py-2">
        <Button type="button" size="icon-xs" variant="ghost" onClick={onBack} aria-label="Back to templates">
          <ArrowLeft className="!h-3.5 !w-3.5" />
        </Button>
        <span className="truncate text-[13px] font-medium">{template.name}</span>
      </div>
      <div className="space-y-3 px-3 pb-2 pt-3">
        {fields.map((f, i) => (
          <div key={f}>
            <Label htmlFor={`tpl-${f}`}>{placeholderLabel(f)}</Label>
            <Input
              id={`tpl-${f}`}
              ref={i === 0 ? firstRef : undefined}
              value={values[f] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
              className="h-8"
            />
          </div>
        ))}
        <div className="max-h-28 overflow-y-auto rounded-lg border border-line bg-base/50 px-2.5 py-2 text-[11.5px] leading-relaxed text-muted">
          {preview.split(/(\{\{[^{}]+\}\})/g).map((part, i) =>
            /^\{\{/.test(part) ? (
              <span key={i} className="rounded bg-accent/10 px-0.5 text-accent">
                {part}
              </span>
            ) : (
              <span key={i}>{part}</span>
            ),
          )}
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-3 py-2">
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" size="sm" variant="primary">
          Insert
        </Button>
      </div>
    </form>
  );
}
