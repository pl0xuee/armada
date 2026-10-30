import { FolderOpen, Puzzle, Slash, Webhook } from "lucide-react";
import type { ReactNode } from "react";
import { attempt } from "@/lib/actions";
import { api } from "@/lib/api";
import { groupHooks, type ConfigEntry, type HookEntry } from "@/lib/projectConfig";
import { Badge } from "../ui/misc";
import { Button } from "../ui/button";

function Group({
  icon,
  title,
  count,
  hint,
  children,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  hint: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-card edge" aria-label={title}>
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:text-steel">
        {icon}
        <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
        <span className="ml-auto text-[11.5px] tabular text-steel">{count}</span>
      </header>
      {count === 0 ? <p className="px-4 py-3 text-[12.5px] leading-relaxed text-steel">{hint}</p> : children}
    </section>
  );
}

function Revealer({ path, label }: { path: string; label: string }) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={`Reveal ${label}`}
      className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
      onClick={() => void attempt("Couldn't show the file", () => api.openPath(path))}
    >
      <FolderOpen />
    </Button>
  );
}

function EntryRows({ entries }: { entries: ConfigEntry[] }) {
  return (
    <ul className="divide-y divide-line">
      {entries.map((e) => (
        <li key={e.path} className="group flex items-start gap-2 px-4 py-2 hover:bg-raised/40">
          <div className="min-w-0 flex-1">
            <code className="font-mono text-[12.5px] text-fg">{e.name}</code>
            {e.description && <p className="mt-0.5 text-[12px] leading-snug text-muted">{e.description}</p>}
          </div>
          <Revealer path={e.path} label={e.name} />
        </li>
      ))}
    </ul>
  );
}

export function ProjectAutomation({
  hooks,
  commands,
  skills,
  files,
}: {
  hooks: HookEntry[];
  commands: ConfigEntry[];
  skills: ConfigEntry[];
  /** Paths of the settings files hooks come from, by scope (revealing a hook shows its file). */
  files: Record<string, string>;
}) {
  return (
    <div className="space-y-4">
      <p className="text-[12px] leading-relaxed text-muted">
        Read-only. These are picked up from the project's <code className="font-mono text-fg">.claude</code> folder
        automatically; edit them in your editor.
      </p>
      <Group
        icon={<Webhook />}
        title="Hooks"
        count={hooks.length}
        hint={
          <>
            No hooks. Add a <code className="font-mono text-muted">hooks</code> section to{" "}
            <code className="font-mono text-muted">.claude/settings.json</code> to run commands on events like{" "}
            <code className="font-mono text-muted">PreToolUse</code> or{" "}
            <code className="font-mono text-muted">Stop</code>.
          </>
        }
      >
        <div className="divide-y divide-line">
          {groupHooks(hooks).map((g) => (
            <div key={g.event} className="px-4 py-2.5">
              <h4 className="font-mono text-[12px] font-semibold text-accent">{g.event}</h4>
              <ul className="mt-1.5 space-y-1.5">
                {g.hooks.map((h, i) => (
                  <li key={i} className="group flex items-start gap-2">
                    {h.matcher && (
                      <Badge className="mt-px max-w-[40%] truncate font-mono" tone="neutral">
                        {h.matcher}
                      </Badge>
                    )}
                    <code className="min-w-0 flex-1 break-all font-mono text-[12.5px] text-fg">{h.command}</code>
                    <Badge tone={h.scope === "local" ? "violet" : "neutral"}>{h.scope}</Badge>
                    {files[h.scope] && <Revealer path={files[h.scope]} label={`${h.event} hook file`} />}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Group>
      <Group
        icon={<Slash />}
        title="Slash commands"
        count={commands.length}
        hint={
          <>
            No custom commands. Put a markdown file in <code className="font-mono text-muted">.claude/commands/</code>{" "}
            and it becomes <code className="font-mono text-muted">/name</code>.
          </>
        }
      >
        <EntryRows entries={commands} />
      </Group>
      <Group
        icon={<Puzzle />}
        title="Skills"
        count={skills.length}
        hint={
          <>
            No skills. Add <code className="font-mono text-muted">.claude/skills/&lt;name&gt;/SKILL.md</code> to teach
            agents a reusable procedure.
          </>
        }
      >
        <EntryRows entries={skills} />
      </Group>
    </div>
  );
}
