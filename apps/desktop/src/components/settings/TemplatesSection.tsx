import { BookText, ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/tooltip";
import { placeholderLabel, templatePlaceholders } from "@/lib/templates";
import type { PromptTemplate } from "@/lib/types";
import { cn, errorMessage, uuid } from "@/lib/utils";
import { useApp } from "@/store/app";
import { SectionHeader } from "./SettingRow";

/** Persist a new template list. Returns false (after toasting) when the backend rejects it. */
async function saveTemplates(templates: PromptTemplate[], failure: string): Promise<boolean> {
  const settings = useApp.getState().settings;
  if (!settings) return false;
  try {
    await useApp.getState().setSettings({ ...settings, templates });
    return true;
  } catch (e) {
    toast.error(failure, { description: errorMessage(e) });
    return false;
  }
}

export function TemplatesSection({ templates }: { templates: PromptTemplate[] }) {
  // null = closed, "new" = creating, otherwise the template being edited
  const [editing, setEditing] = useState<PromptTemplate | "new" | null>(null);
  const [deleting, setDeleting] = useState<PromptTemplate | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const move = async (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= templates.length) return;
    const next = templates.slice();
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    const ok = await saveTemplates(next, "Couldn't reorder templates");
    if (!ok) return;
    // Keep keyboard focus on the moved row; fall back to the other arrow at the list edges.
    requestAnimationFrame(() => {
      const root = listRef.current;
      if (!root) return;
      const want = root.querySelector<HTMLButtonElement>(`[data-move="${item.id}:${dir}"]:not(:disabled)`);
      const other = root.querySelector<HTMLButtonElement>(`[data-move="${item.id}:${-dir}"]`);
      (want ?? other)?.focus();
    });
  };

  const remove = async (t: PromptTemplate) => {
    const index = templates.findIndex((x) => x.id === t.id);
    const ok = await saveTemplates(
      templates.filter((x) => x.id !== t.id),
      "Couldn't delete template",
    );
    setDeleting(null);
    if (!ok) return;
    toast(`Deleted “${t.name}”`, {
      action: {
        label: "Undo",
        onClick: () => {
          const current = useApp.getState().settings?.templates ?? [];
          if (current.some((x) => x.id === t.id)) return;
          const restored = current.slice();
          restored.splice(Math.min(index, restored.length), 0, t);
          void saveTemplates(restored, "Couldn't restore template");
        },
      },
    });
  };

  return (
    <>
      <SectionHeader
        title="Templates"
        description="Reusable prompts for the composer, new agents and schedules."
        right={
          <Button variant="secondary" onClick={() => setEditing("new")}>
            <Plus /> New template
          </Button>
        }
      />

      {templates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong bg-card/40">
          <EmptyState
            icon={<BookText />}
            title="No templates yet"
            description={
              <>
                Save prompts you use often. Add <code className="font-mono text-fg">{"{{fields}}"}</code> and Armada
                asks for them when you insert the template.
              </>
            }
            action={
              <Button variant="primary" onClick={() => setEditing("new")}>
                <Plus /> Create a template
              </Button>
            }
          />
        </div>
      ) : (
        <ul
          ref={listRef}
          aria-label="Prompt templates"
          className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card edge"
        >
          {templates.map((t, i) => {
            const fields = templatePlaceholders(t.body);
            return (
              <li key={t.id} className="group flex items-start gap-3 px-3 py-3 transition-colors hover:bg-raised/40">
                <div className="flex shrink-0 flex-col gap-px pt-0.5" role="group" aria-label={`Reorder ${t.name}`}>
                  <MoveButton
                    data-move={`${t.id}:-1`}
                    label={`Move ${t.name} up`}
                    disabled={i === 0}
                    onClick={() => void move(i, -1)}
                  >
                    <ChevronUp />
                  </MoveButton>
                  <MoveButton
                    data-move={`${t.id}:1`}
                    label={`Move ${t.name} down`}
                    disabled={i === templates.length - 1}
                    onClick={() => void move(i, 1)}
                  >
                    <ChevronDown />
                  </MoveButton>
                </div>
                <button
                  type="button"
                  onClick={() => setEditing(t)}
                  className="min-w-0 flex-1 rounded-md text-left"
                  aria-label={`Edit ${t.name}`}
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-medium text-fg">{t.name}</span>
                    {fields.map((f) => (
                      <FieldChip key={f} name={f} />
                    ))}
                  </span>
                  <span className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-muted">
                    <HighlightedBody body={t.body} />
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  <Tooltip content="Edit">
                    <Button size="icon-sm" variant="ghost" aria-label={`Edit ${t.name}`} onClick={() => setEditing(t)}>
                      <Pencil className="!h-3.5 !w-3.5" />
                    </Button>
                  </Tooltip>
                  <Tooltip content="Delete">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Delete ${t.name}`}
                      onClick={() => setDeleting(t)}
                      className="hover:text-err"
                    >
                      <Trash2 className="!h-3.5 !w-3.5" />
                    </Button>
                  </Tooltip>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-3 text-[12px] text-steel">
        Insert templates from the composer, the New agent dialog or a schedule. Order here is the order in the picker.
      </p>

      <TemplateDialog
        key={editing === null ? "closed" : editing === "new" ? "new" : editing.id}
        editing={editing}
        templates={templates}
        onClose={() => setEditing(null)}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        danger
        title="Delete template?"
        description={deleting ? `“${deleting.name}” will be removed from every template picker.` : undefined}
        confirmLabel="Delete"
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      />
    </>
  );
}

function MoveButton({
  label,
  disabled,
  onClick,
  children,
  "data-move": dataMove,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
  "data-move": string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-move={dataMove}
      disabled={disabled}
      onClick={onClick}
      className="flex h-[18px] w-6 items-center justify-center rounded text-steel transition-colors hover:bg-gunmetal hover:text-fg disabled:pointer-events-none disabled:opacity-25 [&_svg]:h-3.5 [&_svg]:w-3.5"
    >
      {children}
    </button>
  );
}

/** Template body with {{fields}} tinted, for previews. */
function HighlightedBody({ body }: { body: string }) {
  return (
    <>
      {body.split(/(\{\{[^{}]+\}\})/g).map((part, i) =>
        /^\{\{[^{}]+\}\}$/.test(part) ? (
          <span key={i} className="font-mono text-[11px] text-accent">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function FieldChip({ name }: { name: string }) {
  return (
    <span className="inline-flex h-[18px] items-center rounded-md border border-accent/25 bg-accent/[0.08] px-1.5 font-mono text-[10.5px] text-accent">
      {name}
    </span>
  );
}

function TemplateDialog({
  editing,
  templates,
  onClose,
}: {
  editing: PromptTemplate | "new" | null;
  templates: PromptTemplate[];
  onClose: () => void;
}) {
  const initial = editing && editing !== "new" ? editing : null;
  const [name, setName] = useState(initial?.name ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [touched, setTouched] = useState({ name: false, body: false });
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const fields = useMemo(() => templatePlaceholders(body), [body]);
  const nameError = !name.trim()
    ? "Give the template a name."
    : templates.some((t) => t.id !== initial?.id && t.name.trim().toLowerCase() === name.trim().toLowerCase())
      ? "Another template already uses this name."
      : null;
  const bodyError = !body.trim() ? "The prompt can't be empty." : null;
  const unbalanced = (body.match(/\{\{/g)?.length ?? 0) !== (body.match(/\}\}/g)?.length ?? 0);
  const valid = !nameError && !bodyError;
  const dirty = name !== (initial?.name ?? "") || body !== (initial?.body ?? "");

  const submit = async () => {
    setTouched({ name: true, body: true });
    if (!valid || saving) return;
    setSaving(true);
    const next: PromptTemplate = { id: initial?.id ?? uuid(), name: name.trim(), body: body.trim() };
    const list = initial ? templates.map((t) => (t.id === initial.id ? next : t)) : [...templates, next];
    const ok = await saveTemplates(list, initial ? "Couldn't save template" : "Couldn't create template");
    setSaving(false);
    if (ok) {
      toast.success(initial ? "Template saved" : `Created “${next.name}”`);
      onClose();
    }
  };

  return (
    <Dialog open={editing !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={initial ? "Edit template" : "New template"}
        description="Templates are inserted into the prompt box; you can still edit them before sending."
        className="w-[min(600px,calc(100vw-32px))]"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          nameRef.current?.focus();
        }}
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogBody className="space-y-4">
            <div>
              <Label htmlFor="tpl-name">Name</Label>
              <Input
                id="tpl-name"
                ref={nameRef}
                value={name}
                maxLength={80}
                placeholder="e.g. Write tests"
                aria-invalid={touched.name && !!nameError}
                aria-describedby={touched.name && nameError ? "tpl-name-err" : undefined}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                className={cn(touched.name && nameError && "border-err/60 focus:border-err/70 focus:ring-err/15")}
              />
              {touched.name && nameError && <FieldError id="tpl-name-err">{nameError}</FieldError>}
            </div>
            <div>
              <Label htmlFor="tpl-body">Prompt</Label>
              <Textarea
                id="tpl-body"
                value={body}
                placeholder={"Write tests for {{target}}. Cover edge cases and failure paths."}
                aria-invalid={touched.body && !!bodyError}
                aria-describedby="tpl-body-hint"
                onChange={(e) => setBody(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, body: true }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                className={cn(
                  "min-h-[168px] font-mono text-[12.5px] leading-relaxed",
                  touched.body && bodyError && "border-err/60 focus:border-err/70 focus:ring-err/15",
                )}
              />
              {touched.body && bodyError && <FieldError>{bodyError}</FieldError>}
              <p id="tpl-body-hint" className="mt-1.5 text-[12px] leading-relaxed text-steel">
                Wrap a word in double braces, like <code className="font-mono text-muted">{"{{file}}"}</code>, to make
                it a field you fill in when inserting.
              </p>
            </div>
            <div className="rounded-lg border border-line bg-base/40 px-3 py-2.5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-steel">Fields</div>
              {fields.length === 0 ? (
                <p className="mt-1 text-[12px] text-muted">None. The template is inserted as-is.</p>
              ) : (
                <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Detected fields">
                  {fields.map((f) => (
                    <li key={f} className="flex items-center gap-1.5">
                      <FieldChip name={f} />
                      <span className="text-[11.5px] text-muted">{placeholderLabel(f)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {unbalanced && (
                <p className="mt-1.5 text-[12px] text-warn">
                  Some braces aren't closed, so they'll be inserted literally.
                </p>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!valid || saving || (!!initial && !dirty)}>
              {saving && <Spinner className="h-3.5 w-3.5 text-current" />}
              {initial ? "Save changes" : "Create template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function FieldError({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <p id={id} role="alert" className="mt-1.5 text-[12px] text-err">
      {children}
    </p>
  );
}
