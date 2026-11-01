import { BookOpen, FolderOpen, Plus, Puzzle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Markdown } from "@/components/Markdown";
import { InlineError } from "@/components/settings/ProjectNotice";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Badge, Spinner } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { attempt } from "@/lib/actions";
import { api } from "@/lib/api";
import {
  groupSkills,
  NO_TOGGLES,
  offNote,
  offScope,
  onScopes,
  SKILL_SCOPE_LABEL,
  skillNameProblem,
  skillSwitch,
  slugifySkill,
  type SkillDoc,
  type SkillInfo,
  type SkillToggles,
  type SwitchScope,
} from "@/lib/toolkit";
import { basename, cn, errorMessage, prettyPath } from "@/lib/utils";
import { RestartNote } from "./RestartNote";

/** The skills Claude Code loads: yours, the project's and installed plugins'. View, create, locate. */
export function SkillsPanel({ project }: { project: string | null }) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<SkillInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [toggles, setToggles] = useState<SkillToggles>(NO_TOGGLES);
  // Where switching one of your own skills off goes, when a project is open.
  const [offIn, setOffIn] = useState<SwitchScope>("global");
  const [busy, setBusy] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const [list, off] = await Promise.all([api.skillsList(project), api.skillsToggles(project)]);
      if (ticket === latest.current) {
        setSkills(list);
        setToggles(off);
      }
    } catch (e) {
      if (ticket === latest.current) setError(errorMessage(e));
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    setSkills(null);
    void load();
    return () => {
      latest.current++;
    };
  }, [load]);

  const projectName = project ? basename(project) || project : null;

  /** Switch off in the chosen scope, or back on everywhere it is off. */
  const setOn = async (skill: SkillInfo, on: boolean) => {
    const sw = skillSwitch(skill, toggles);
    setBusy(skill.id);
    try {
      let next = toggles;
      if (on) {
        for (const scope of onScopes(sw)) next = await api.skillsSetEnabled(project, scope, skill.id, true);
      } else {
        next = await api.skillsSetEnabled(project, offScope(skill, offIn, project), skill.id, false);
      }
      setToggles(next);
      setChanged(true);
    } catch (e) {
      toast.error(`Couldn't switch ${skill.name} ${on ? "on" : "off"}`, { description: errorMessage(e) });
      void load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 basis-[260px] text-[13px] leading-[20px] text-muted">
          Skills Claude Code can load on demand. Switch one off to hide it from Claude agents; Kvistcode only keeps a
          list, so your skill files are never moved, renamed or changed.
        </p>
        <div className="flex shrink-0 gap-1.5">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Reload skills"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            <Plus /> New skill
          </Button>
        </div>
      </div>

      <RestartNote provider="claude" project={project} changed={changed} className="mb-4" />

      {project && skills?.some((s) => s.scope === "user") && (
        <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-xs font-medium text-muted">Switching off one of yours applies to</span>
          <Segmented<SwitchScope>
            size="sm"
            aria-label="Where switching a skill off applies"
            value={offIn}
            onChange={setOffIn}
            options={[
              { value: "global", label: "Every project" },
              { value: "project", label: `Only ${projectName}` },
            ]}
          />
        </div>
      )}

      {error ? (
        <InlineError message={error} />
      ) : !skills ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading skills">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : skills.length === 0 ? (
        <div className="flex items-center gap-3 rounded-xl border border-dashed border-line-strong bg-card/40 px-4 py-5">
          <Puzzle className="h-4 w-4 shrink-0 text-steel" />
          <p className="text-[12.5px] leading-[18px] text-muted">
            No skills yet. A skill is a folder with a SKILL.md that teaches Claude a repeatable job, like your release
            process or how to read a PDF.
          </p>
        </div>
      ) : (
        groupSkills(skills).map((g) => (
          <section key={g.scope} aria-label={SKILL_SCOPE_LABEL[g.scope]} className="mb-6">
            <h3 className="mb-2 px-0.5 text-[13px] font-semibold leading-[18px] tracking-tight text-fg">
              {g.scope === "project" && project ? `Only ${basename(project) || project}` : SKILL_SCOPE_LABEL[g.scope]}
              <span className="tabular ml-2 text-[11.5px] font-normal text-steel">{g.skills.length}</span>
            </h3>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card edge">
              {g.skills.map((s) => {
                const sw = skillSwitch(s, toggles);
                const note = offNote(sw, projectName);
                return (
                  <li key={s.id} className="flex items-start">
                    <button
                      type="button"
                      onClick={() => setOpen(s)}
                      className="flex min-w-0 flex-1 items-start gap-3 py-3 pl-4 pr-2 text-left transition-colors hover:bg-raised/40"
                      aria-label={`View ${s.name}`}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-raised",
                          sw.on ? "text-accent" : "text-steel",
                        )}
                      >
                        <BookOpen className="h-4 w-4" />
                      </span>
                      <span className={cn("min-w-0 flex-1", !sw.on && "opacity-60")}>
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium leading-[20px] text-fg">{s.name}</span>
                          {s.plugin && <Badge>{s.plugin}</Badge>}
                        </span>
                        <span className="line-clamp-2 text-[12px] leading-[18px] text-muted">
                          {s.description || "No description"}
                        </span>
                      </span>
                    </button>
                    <div className="flex shrink-0 flex-col items-end gap-1 py-3 pl-2 pr-4">
                      {sw.managedBy ? (
                        <Tooltip content="Turn it off from the plugin's own settings; Kvistcode can't switch plugin skills.">
                          <span className="inline-flex h-[20px] cursor-default items-center text-[11.5px] text-steel">
                            Managed by {sw.managedBy}
                          </span>
                        </Tooltip>
                      ) : (
                        <>
                          <Switch
                            checked={sw.on}
                            disabled={busy === s.id}
                            aria-label={`${s.name} for Claude agents`}
                            onCheckedChange={(on) => void setOn(s, on)}
                          />
                          {note && <span className="text-[11.5px] leading-[16px] text-steel">{note}</span>}
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}

      <SkillViewer project={project} skill={open} onClose={() => setOpen(null)} />
      <NewSkillDialog
        open={creating}
        project={project}
        onClose={() => setCreating(false)}
        onCreated={(s) => {
          setCreating(false);
          void load();
          setOpen(s);
        }}
      />
    </>
  );
}

function SkillViewer({
  project,
  skill,
  onClose,
}: {
  project: string | null;
  skill: SkillInfo | null;
  onClose: () => void;
}) {
  const [doc, setDoc] = useState<SkillDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const id = skill?.id ?? null;

  useEffect(() => {
    setDoc(null);
    setError(null);
    setRaw(false);
    if (id === null) return;
    let live = true;
    api.skillsRead(project, id).then(
      (d) => live && setDoc(d),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [project, id]);

  return (
    <Dialog open={skill !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={skill?.name ?? "Skill"}
        description={
          skill
            ? skill.scope === "plugin"
              ? `From the ${skill.plugin} plugin. Read-only.`
              : prettyPath(skill.path)
            : undefined
        }
        className="w-[min(680px,calc(100vw-32px))]"
        sheet
      >
        <DialogBody>
          {error ? (
            <InlineError message={error} />
          ) : !doc ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between gap-2">
                <Segmented<"preview" | "source">
                  size="sm"
                  aria-label="View"
                  value={raw ? "source" : "preview"}
                  onChange={(v) => setRaw(v === "source")}
                  options={[
                    { value: "preview", label: "Preview" },
                    { value: "source", label: "SKILL.md" },
                  ]}
                />
                {doc.files.length > 0 && (
                  <span className="min-w-0 truncate text-[11.5px] text-steel" title={doc.files.join(", ")}>
                    Also in the folder: {doc.files.slice(0, 4).join(", ")}
                    {doc.files.length > 4 ? ` +${doc.files.length - 4}` : ""}
                  </span>
                )}
              </div>
              {raw ? (
                <pre className="selectable max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-base/60 p-3 font-mono text-[12px] leading-[18px] text-muted">
                  {doc.content}
                </pre>
              ) : (
                <div className="selectable max-h-[420px] overflow-y-auto rounded-lg border border-line bg-base/40 px-4 py-3 text-[13px]">
                  <Markdown text={stripFrontmatter(doc.content)} />
                </div>
              )}
              {doc.truncated && (
                <p className="mt-2 text-[12px] leading-[18px] text-steel">Only the start of this file is shown.</p>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {skill && (
            <Button
              variant="secondary"
              onClick={() => void attempt("Couldn't show the file", () => api.openPath(skill.path))}
            >
              <FolderOpen /> Show in folder
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The `---` block at the top is metadata, not something to read as a heading and a rule. */
function stripFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

function NewSkillDialog({
  open,
  project,
  onClose,
  onCreated,
}: {
  open: boolean;
  project: string | null;
  onClose: () => void;
  onCreated: (skill: SkillInfo) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setScope(project ? "project" : "user");
    setAttempted(false);
    setError(null);
  }, [open, project]);

  const problem = skillNameProblem(name);
  const submit = async () => {
    setAttempted(true);
    if (problem || saving) return;
    setSaving(true);
    setError(null);
    try {
      const made = await api.skillsCreate(project, scope, name.trim(), description);
      toast.success(`Created ${made.name}`, { description: "Edit its SKILL.md to fill in the steps." });
      onCreated(made);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="New skill" description="Creates a folder with a SKILL.md you can edit.">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogBody className="space-y-4">
            <div>
              <Label htmlFor="skill-name">Name</Label>
              <Input
                id="skill-name"
                value={name}
                maxLength={64}
                autoFocus
                placeholder="code-review"
                aria-invalid={attempted && !!problem}
                onChange={(e) => setName(slugifyWhileTyping(e.target.value))}
                className={cn("font-mono text-[12.5px]", attempted && problem && "border-err/60")}
              />
              <p className={cn("mt-1.5 text-[12px] leading-[18px]", attempted && problem ? "text-err" : "text-steel")}>
                {attempted && problem
                  ? problem
                  : "Lowercase letters, digits and hyphens. This becomes the folder name."}
              </p>
            </div>
            <div>
              <Label htmlFor="skill-desc">Description</Label>
              <Textarea
                id="skill-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What it does and when Claude should use it."
                className="min-h-[72px] text-[13px]"
              />
              <p className="mt-1.5 text-[12px] leading-[18px] text-steel">
                Claude reads this to decide when to load the skill, so be specific.
              </p>
            </div>
            <div>
              <span className="mb-1.5 block text-xs font-medium text-muted">Available to</span>
              <Segmented<"user" | "project">
                aria-label="Skill scope"
                value={scope}
                onChange={setScope}
                className="w-full"
                options={[
                  { value: "user", label: "Me, in every project" },
                  {
                    value: "project",
                    label: project ? `Only ${basename(project) || project}` : "A project",
                    disabled: !project,
                  },
                ]}
              />
            </div>
            {error && <InlineError message={error} />}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving && <Spinner className="h-3.5 w-3.5 text-current" />}
              Create skill
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Folder-name friendly as you type: spaces become hyphens, other characters are dropped. */
function slugifyWhileTyping(value: string): string {
  // Keep a trailing hyphen so "code-" can become "code-review".
  const trailing = /[\s-]$/.test(value) ? "-" : "";
  const slug = slugifySkill(value);
  return slug ? slug + trailing : "";
}
