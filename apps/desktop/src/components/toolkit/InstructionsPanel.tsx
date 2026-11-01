import { Check, FileText, FolderOpen, RefreshCw, RotateCcw, Save, Sparkles, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Markdown } from "@/components/Markdown";
import { InlineError } from "@/components/settings/ProjectNotice";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Badge, Spinner } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { attempt } from "@/lib/actions";
import { api } from "@/lib/api";
import type { InstructionDoc, InstructionFileName } from "@/lib/projectConfig";
import { checkDisk, INSTRUCTION_INFO, starterPrompt } from "@/lib/toolkit";
import { cn, errorMessage, modKey, prettyPath } from "@/lib/utils";
import { draftKey, useProjectSettings } from "@/store/projectSettings";
import { useUi } from "@/store/ui";

const FILES: InstructionFileName[] = ["CLAUDE.md", "AGENTS.md"];
type Docs = Partial<Record<InstructionFileName, InstructionDoc>>;

const TEMPLATE = (file: InstructionFileName) =>
  `# ${file.replace(/\.md$/, "")}\n\n## Build and test\n\n- \n\n## Layout\n\n- \n\n## Conventions\n\n- \n\n## Avoid\n\n- \n`;

/** Project instruction files: edit with a preview, save safely, notice edits made elsewhere. */
export function InstructionsPanel({ project }: { project: string }) {
  const [docs, setDocs] = useState<Docs>({});
  const [conflicts, setConflicts] = useState<Docs>({});
  const [file, setFile] = useState<InstructionFileName>("CLAUDE.md");
  const [error, setError] = useState<string | null>(null);
  const drafts = useProjectSettings((s) => s.drafts);
  const latest = useRef(0);
  const docsRef = useRef(docs);
  docsRef.current = docs;

  const textOf = (f: InstructionFileName) => {
    const draft = useProjectSettings.getState().drafts[draftKey(project, f)];
    return draft ?? docsRef.current[f]?.content ?? "";
  };
  const isDirty = (f: InstructionFileName) => {
    const draft = useProjectSettings.getState().drafts[draftKey(project, f)];
    return draft !== undefined && draft !== (docsRef.current[f]?.content ?? "");
  };

  useEffect(() => {
    const ticket = ++latest.current;
    setDocs({});
    setConflicts({});
    setError(null);
    Promise.all(FILES.map((f) => api.instructionsRead(project, f))).then(
      (list) => {
        if (ticket === latest.current) setDocs(Object.fromEntries(list.map((d) => [d.file, d])));
      },
      (e) => {
        if (ticket === latest.current) setError(errorMessage(e));
      },
    );
    return () => {
      latest.current++;
    };
  }, [project]);

  /** Looks at the file on disk again; adopts it when there is nothing to lose, flags a conflict otherwise. */
  const checkFile = useCallback(
    async (f: InstructionFileName) => {
      const loaded = docsRef.current[f];
      if (!loaded) return;
      const ticket = latest.current;
      let disk: InstructionDoc;
      try {
        disk = await api.instructionsRead(project, f);
      } catch {
        return;
      }
      if (ticket !== latest.current) return;
      const verdict = checkDisk({ dirty: isDirty(f), loadedStamp: loaded.stamp, disk, text: textOf(f) });
      if (verdict === "reload") {
        setDocs((d) => ({ ...d, [f]: disk }));
        setConflicts((c) => ({ ...c, [f]: undefined }));
        if (disk.content !== loaded.content) toast(`${f} was updated on disk`);
      } else if (verdict === "conflict") {
        setConflicts((c) => ({ ...c, [f]: disk }));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project],
  );

  // Edits made in another editor or by an agent show up when the window is looked at again.
  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState === "hidden") return;
      for (const f of FILES) void checkFile(f);
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [checkFile]);

  const doc = docs[file];
  const dirtyFiles = FILES.filter((f) => {
    const d = drafts[draftKey(project, f)];
    return d !== undefined && d !== (docs[f]?.content ?? "");
  });

  if (error) {
    return (
      <div className="rounded-xl border border-err/30 bg-err/[0.07] px-4 py-3">
        <InlineError message={error} />
      </div>
    );
  }

  return (
    <div>
      <Segmented<InstructionFileName>
        aria-label="Instruction file"
        className="mb-4"
        value={file}
        onChange={setFile}
        options={FILES.map((f) => ({
          value: f,
          label: (
            <>
              <span className="font-mono">{f}</span>
              {dirtyFiles.includes(f) ? (
                <span className="h-1.5 w-1.5 rounded-full bg-warn" role="img" aria-label="unsaved changes" />
              ) : docs[f] && !docs[f]!.exists ? (
                <span className="text-[11px] text-steel">new</span>
              ) : null}
            </>
          ),
        }))}
      />
      {!doc ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading instructions">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <InstructionEditor
          key={`${project}\u0000${file}`}
          project={project}
          doc={doc}
          conflict={conflicts[file] ?? null}
          onDoc={(d) => {
            setDocs((all) => ({ ...all, [d.file]: d }));
            setConflicts((c) => ({ ...c, [d.file]: undefined }));
          }}
          onConflict={(d) => setConflicts((c) => ({ ...c, [d.file]: d }))}
          onRecheck={() => void checkFile(file)}
          siblingExists={docs[file === "CLAUDE.md" ? "AGENTS.md" : "CLAUDE.md"]?.exists ?? false}
        />
      )}
    </div>
  );
}

function InstructionEditor({
  project,
  doc,
  conflict,
  onDoc,
  onConflict,
  onRecheck,
  siblingExists,
}: {
  project: string;
  doc: InstructionDoc;
  conflict: InstructionDoc | null;
  onDoc: (doc: InstructionDoc) => void;
  onConflict: (disk: InstructionDoc) => void;
  onRecheck: () => void;
  siblingExists: boolean;
}) {
  const file = doc.file;
  const info = INSTRUCTION_INFO[file];
  const key = draftKey(project, file);
  const draft = useProjectSettings((s) => s.drafts[key]);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(savedTimer.current), []);

  const text = draft ?? doc.content;
  const dirty = draft !== undefined && draft !== doc.content;
  const locked = doc.error !== null;
  const setText = (value: string) => {
    const store = useProjectSettings.getState();
    // Typing back to what is saved is not an edit.
    if (value === doc.content) store.clearDraft(key);
    else store.setDraft(key, value);
  };

  const save = async (force = false) => {
    if ((!dirty && !force) || saving || locked) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.instructionsSave(project, file, text, doc.stamp ?? null, force);
      if (res.saved || res.doc.content === text) {
        useProjectSettings.getState().clearDraft(key);
        onDoc(res.doc);
        setJustSaved(true);
        clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setJustSaved(false), 2200);
      } else {
        onConflict(res.doc);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const useDisk = () => {
    if (!conflict) return;
    useProjectSettings.getState().clearDraft(key);
    onDoc(conflict);
  };

  const draftWithAgent = () => {
    useUi.getState().openNewAgent({ projectPath: project, provider: info.starter, prompt: starterPrompt(file) });
  };

  const empty = !doc.exists && text === "";

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-card edge" aria-label={file}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3">
        <FileText className="h-4 w-4 shrink-0 text-steel" />
        <div className="min-w-0 flex-1 basis-[220px]">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-[13px] font-semibold leading-[20px] text-fg">{file}</h3>
            {!doc.exists && !dirty && <Badge>Not created yet</Badge>}
            {dirty && <Badge tone="warn">Unsaved changes</Badge>}
            {justSaved && !dirty && (
              <Badge tone="ok">
                <Check /> Saved
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-[12px] leading-[18px] text-muted">
            {info.blurb}{" "}
            <span className="text-steel">
              Read by <span className="text-muted">{info.readers.join(", ")}</span>.
            </span>
          </p>
        </div>
        <Segmented<"edit" | "preview">
          size="sm"
          aria-label="View"
          value={mode}
          onChange={setMode}
          options={[
            { value: "edit", label: "Edit" },
            { value: "preview", label: "Preview" },
          ]}
        />
      </header>

      {conflict && (
        <div role="alert" className="border-b border-warn/30 bg-warn/[0.07] px-4 py-3">
          <p className="flex items-start gap-2 text-[12.5px] leading-[18px] text-fg">
            <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-warn" />
            <span>
              <span className="font-medium">{file} changed on disk</span> since you opened it
              {dirty ? ", and you have unsaved edits" : ""}. Saving now would overwrite that change.
            </span>
          </p>
          <details className="mt-2 text-[12px] text-muted">
            <summary className="cursor-pointer select-none text-steel hover:text-fg">Show what is on disk</summary>
            <pre className="selectable mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-base/60 p-2.5 font-mono text-[12px] leading-[18px] text-muted">
              {conflict.content || "(empty)"}
            </pre>
          </details>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={useDisk}>
              <RefreshCw /> Load the disk version
            </Button>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => void save(true)}>
              Overwrite with mine
            </Button>
          </div>
        </div>
      )}

      <div className="p-3">
        {mode === "edit" ? (
          <>
            <textarea
              aria-label={`${file} contents`}
              value={text}
              disabled={locked}
              spellCheck={false}
              placeholder={
                locked
                  ? ""
                  : "Tell agents how this project works: build and test commands, conventions, things to avoid."
              }
              onChange={(e) => setText(e.target.value)}
              onFocus={onRecheck}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  void save();
                }
              }}
              className={cn(fieldClass, "min-h-[280px] resize-y py-2.5 font-mono text-[12.5px] leading-[20px]")}
            />
            {empty && !locked && (
              <div className="mt-2.5 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setText(TEMPLATE(file))}>
                  <FileText /> Start from a template
                </Button>
                <Button size="sm" variant="ghost" onClick={draftWithAgent}>
                  <Sparkles /> Have an agent draft it
                </Button>
              </div>
            )}
          </>
        ) : (
          <div
            className="selectable min-h-[280px] max-h-[520px] overflow-y-auto rounded-lg border border-line bg-base/40 px-4 py-3 text-[13px]"
            aria-label={`${file} preview`}
          >
            {text.trim() ? (
              <Markdown text={text} />
            ) : (
              <p className="text-[13px] leading-[20px] text-steel">Nothing to preview yet.</p>
            )}
          </div>
        )}
        {file === "CLAUDE.md" && !doc.exists && siblingExists && (
          <p className="mt-2.5 text-[12px] leading-[18px] text-steel">
            Claude doesn't read AGENTS.md. To share it, put <code className="font-mono text-muted">@AGENTS.md</code> in
            this file.
          </p>
        )}
        {(doc.error || error) && <InlineError message={(doc.error ?? error) as string} />}
      </div>

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-4 py-2.5">
        <span
          className="min-w-0 flex-1 basis-[180px] truncate text-[11.5px] leading-[16px] text-steel"
          title={doc.path}
        >
          {prettyPath(doc.path)}
        </span>
        <span className="hidden items-center gap-1.5 text-[11.5px] text-steel sm:inline-flex">
          <Kbd>{modKey}</Kbd>
          <Kbd>S</Kbd> to save
        </span>
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
            aria-label={`Reveal ${file} in its folder`}
            onClick={() => void attempt("Couldn't show the file", () => api.openPath(doc.path))}
          >
            <FolderOpen /> Reveal
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={!dirty || saving || locked} onClick={() => void save()}>
          {saving ? <Spinner /> : <Save />} {doc.exists ? "Save" : "Create"}
        </Button>
      </footer>
    </section>
  );
}
