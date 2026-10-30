import { useEffect, useMemo, useRef, useState } from "react";
import { allFieldsFilled, fillTemplate, filterTemplates, placeholderLabel, templateParts, templatePlaceholders } from "@/lib/templates";
import type { PromptTemplate } from "@/lib/types";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";
import { Button } from "./ui";

/**
 * Prompt-template picker for the composer (the desktop's TemplatePicker).
 * A template with `{{placeholders}}` opens a small fill-in form first; the
 * filled text goes to `onInsert`.
 */
export function TemplateSheet({
  open,
  templates,
  onClose,
  onInsert,
}: {
  open: boolean;
  templates: PromptTemplate[];
  onClose: () => void;
  onInsert: (text: string) => void;
}) {
  const [filling, setFilling] = useState<PromptTemplate | null>(null);
  const close = () => {
    onClose();
    setFilling(null);
  };
  return (
    <Sheet
      open={open}
      onClose={close}
      title={filling ? filling.name : "Templates"}
      description={filling ? "Fill in the blanks" : "Insert a saved prompt into your message"}
    >
      {filling ? (
        <FillForm
          key={filling.id}
          template={filling}
          onBack={() => setFilling(null)}
          onDone={(text) => {
            onInsert(text);
            close();
          }}
        />
      ) : (
        <TemplateList
          templates={templates}
          onChoose={(t) => {
            if (templatePlaceholders(t.text).length > 0) setFilling(t);
            else {
              onInsert(t.text);
              close();
            }
          }}
        />
      )}
    </Sheet>
  );
}

function TemplateList({ templates, onChoose }: { templates: PromptTemplate[]; onChoose: (t: PromptTemplate) => void }) {
  const [query, setQuery] = useState("");
  const list = useMemo(() => filterTemplates(templates, query), [templates, query]);
  return (
    <div className="space-y-3">
      {templates.length > 6 && (
        <div className="relative">
          <Icon name="search" size={17} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-steel" />
          <label htmlFor="template-search" className="sr-only">
            Search templates
          </label>
          <input
            id="template-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search templates"
            autoComplete="off"
            className="block h-11 w-full rounded-xl border border-line bg-card pr-3 pl-10 text-[16px] text-fg outline-none placeholder:text-steel focus:border-accent/60"
          />
        </div>
      )}
      {list.length === 0 ? (
        <p className="py-8 text-center text-[14px] text-steel">{templates.length === 0 ? "No templates yet. Add them in Armada on your computer." : "No templates match."}</p>
      ) : (
        <ul aria-label="Templates" className="overflow-hidden rounded-2xl border border-line bg-card">
          {list.map((t, i) => {
            const fields = templatePlaceholders(t.text).length;
            return (
              <li key={t.id} className={i > 0 ? "border-t border-line/70" : undefined}>
                <button type="button" onClick={() => onChoose(t)} className="press-row flex min-h-14 w-full flex-col gap-0.5 px-3.5 py-2.5 text-left">
                  <span className="flex items-center gap-2 text-[15px] font-medium text-fg">
                    <span className="min-w-0 truncate">{t.name}</span>
                    {fields > 0 && (
                      <span className="shrink-0 rounded-md border border-line-strong px-1.5 text-[11px] font-normal text-steel">
                        {fields} field{fields === 1 ? "" : "s"}
                      </span>
                    )}
                  </span>
                  <span className="line-clamp-2 text-[13px] leading-snug text-muted">
                    {templateParts(t.text).map((p, j) =>
                      "field" in p ? (
                        <span key={j} className="mx-px rounded-md bg-accent/10 px-1.5 py-px text-[12px] font-medium whitespace-nowrap text-accent">
                          {placeholderLabel(p.field)}
                        </span>
                      ) : (
                        <span key={j}>{p.text}</span>
                      ),
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FillForm({ template, onBack, onDone }: { template: PromptTemplate; onBack: () => void; onDone: (text: string) => void }) {
  const fields = useMemo(() => templatePlaceholders(template.text), [template.text]);
  const [values, setValues] = useState<Record<string, string>>({});
  const preview = fillTemplate(template.text, values);
  const ready = allFieldsFilled(fields, values);
  // Straight into the first blank, once the sheet has settled (so iOS raises the keyboard).
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => first.current?.focus({ preventScroll: true }), 150);
    return () => clearTimeout(t);
  }, []);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onDone(preview);
      }}
    >
      {fields.map((f, i) => (
        <div key={f}>
          <label htmlFor={`tpl-${i}`} className="mb-1.5 block text-[13px] font-medium text-muted">
            {placeholderLabel(f)}
          </label>
          <input
            id={`tpl-${i}`}
            ref={i === 0 ? first : undefined}
            value={values[f] ?? ""}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setValues((cur) => ({ ...cur, [f]: v }));
            }}
            autoComplete="off"
            enterKeyHint={i === fields.length - 1 ? "done" : "next"}
            className="block h-12 w-full rounded-xl border border-line-strong bg-card px-3.5 text-[16px] text-fg outline-none focus:border-accent/60"
          />
        </div>
      ))}
      <div>
        <p className="mb-1.5 text-[13px] font-medium text-muted">Preview</p>
        <div className="max-h-32 overflow-y-auto rounded-xl border border-line bg-code px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-muted">
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
      {!ready && <p className="text-center text-[12.5px] text-steel">Fill in {fields.length === 1 ? "the field" : "every field"} to insert.</p>}
      <div className="grid grid-cols-2 gap-2 pt-1">
        <Button variant="secondary" size="lg" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" variant="primary" size="lg" disabled={!ready}>
          Insert
        </Button>
      </div>
    </form>
  );
}
