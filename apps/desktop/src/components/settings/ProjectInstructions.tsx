import { Check, ChevronRight, FileText, FolderOpen, RotateCcw, Save } from "lucide-react";
import { useState } from "react";
import { attempt } from "@/lib/actions";
import { api } from "@/lib/api";
import type { InstructionDoc, InstructionFileName } from "@/lib/projectConfig";
import { cn, errorMessage, modKey, prettyPath } from "@/lib/utils";
import { draftKey, useProjectSettings } from "@/store/projectSettings";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { fieldClass } from "../ui/input";
import { Badge, Spinner } from "../ui/misc";
import { InlineError } from "./ProjectNotice";

const BLURB: Record<InstructionFileName, string> = {
  "CLAUDE.md": "Read by Claude Code at the start of every session in this project.",
  "AGENTS.md": "Read by Codex and other agents that follow the AGENTS.md convention.",
};

/** One markdown file at the project root: edit, save, revert. Unsaved text lives in the store. */
function InstructionEditor({
  project,
  doc,
  onSaved,
}: {
  project: string;
  doc: InstructionDoc;
  onSaved: (doc: InstructionDoc) => void;
}) {
  const key = draftKey(project, doc.file);
  const draft = useProjectSettings((s) => s.drafts[key]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const text = draft ?? doc.content;
  const dirty = draft !== undefined && draft !== doc.content;
  const locked = doc.error !== null;

  const save = async () => {
    if (!dirty || saving || locked) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.projectSaveInstruction(project, doc.file, text);
      useProjectSettings.getState().clearDraft(key);
      onSaved(saved);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2200);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-card edge" aria-label={doc.file}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-3">
        <FileText className="h-4 w-4 shrink-0 text-steel" />
        <div className="min-w-0 flex-1 basis-[200px]">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-[13px] font-semibold text-fg">{doc.file}</h3>
            {!doc.exists && !dirty && <Badge>Not created yet</Badge>}
            {dirty && <Badge tone="warn">Unsaved changes</Badge>}
            {justSaved && !dirty && (
              <Badge tone="ok">
                <Check /> Saved
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-[12px] text-muted">{BLURB[doc.file]}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {dirty && (
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                useProjectSettings.getState().clearDraft(key);
                setError(null);
              }}
            >
              <RotateCcw /> Revert
            </Button>
          )}
          {doc.exists && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Reveal ${doc.file} in its folder`}
              onClick={() => void attempt("Couldn't show the file", () => api.openPath(doc.path))}
            >
              <FolderOpen /> Reveal
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={!dirty || saving || locked} onClick={() => void save()}>
            {saving ? <Spinner /> : <Save />} {doc.exists ? "Save" : "Create"}
          </Button>
        </div>
      </header>
      <div className="p-3">
        <textarea
          aria-label={`${doc.file} contents`}
          value={text}
          disabled={locked}
          spellCheck={false}
          placeholder={
            locked
              ? ""
              : `# ${doc.file}\n\nTell agents how this project works: build and test commands, conventions, things to avoid.`
          }
          onChange={(e) => useProjectSettings.getState().setDraft(key, e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              void save();
            }
          }}
          className={cn(fieldClass, "min-h-[220px] resize-y py-2.5 font-mono text-[12.5px] leading-relaxed")}
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-steel">
          <span className="truncate" title={doc.path}>
            {prettyPath(doc.path)}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>{modKey}</Kbd>
            <Kbd>S</Kbd> to save
          </span>
        </div>
        {(doc.error || error) && <InlineError message={(doc.error ?? error) as string} />}
      </div>
    </section>
  );
}

export function ProjectInstructions({
  project,
  instructions,
  userInstructions,
  onSaved,
}: {
  project: string;
  instructions: InstructionDoc[];
  userInstructions: InstructionDoc | null;
  onSaved: (doc: InstructionDoc) => void;
}) {
  const [showUser, setShowUser] = useState(false);
  return (
    <div className="space-y-4">
      {instructions.map((doc) => (
        <InstructionEditor key={doc.file} project={project} doc={doc} onSaved={onSaved} />
      ))}
      {userInstructions?.exists && (
        <section className="rounded-xl border border-line bg-card/60">
          <button
            type="button"
            aria-expanded={showUser}
            onClick={() => setShowUser((v) => !v)}
            className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left"
          >
            <ChevronRight className={cn("h-3.5 w-3.5 text-steel transition-transform", showUser && "rotate-90")} />
            <span className="text-[13px] font-medium text-fg">Your personal CLAUDE.md</span>
            <Badge>Read-only</Badge>
            <span className="ml-auto truncate text-[11.5px] text-steel">{prettyPath(userInstructions.path)}</span>
          </button>
          {showUser && (
            <div className="px-4 pb-4">
              {userInstructions.error ? (
                <InlineError message={userInstructions.error} />
              ) : (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-base/60 p-3 font-mono text-[12px] leading-relaxed text-muted">
                  {userInstructions.content}
                </pre>
              )}
              <p className="mt-2 text-[11.5px] text-steel">
                Applies to every project. Edit it in your own editor; Armada doesn't change files outside the project.
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
