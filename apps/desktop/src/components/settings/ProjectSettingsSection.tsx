import { FolderCog, FolderOpen, RefreshCw, Shield, Workflow, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { attempt } from "@/lib/actions";
import { api } from "@/lib/api";
import { projectChoices, ruleCount, type ProjectConfig, type SettingsFile } from "@/lib/projectConfig";
import { basename, errorMessage, prettyPath } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useProjectSettings } from "@/store/projectSettings";
import { openToolkit } from "@/store/toolkit";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { Segmented } from "../ui/segmented";
import { Skeleton } from "../ui/skeleton";
import { ProjectAutomation } from "./ProjectAutomation";
import { InlineError } from "./ProjectNotice";
import { ProjectPermissions } from "./ProjectPermissions";
import { SectionHeader } from "./SettingRow";

type Tab = "permissions" | "automation";

/** Settings → Projects: the permission rules, hooks, commands and skills Claude Code reads from a project. */
export function ProjectSettingsSection() {
  const agents = useApp((s) => s.agents);
  const recent = useApp((s) => s.settings?.recentProjects);
  const chosen = useProjectSettings((s) => s.project);
  const setProject = useProjectSettings((s) => s.setProject);

  const choices = useMemo(
    () =>
      projectChoices(
        Object.values(agents).map((a) => a.projectPath),
        recent ?? [],
      ),
    [agents, recent],
  );
  // A project opened from elsewhere (an agent's menu) stays selectable even if it isn't listed.
  const options = chosen && !choices.includes(chosen) ? [chosen, ...choices] : choices;
  const project = chosen && options.includes(chosen) ? chosen : (options[0] ?? null);

  const [tab, setTab] = useState<Tab>("permissions");
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);

  const load = useCallback(async (p: string) => {
    const ticket = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const cfg = await api.projectConfig(p);
      if (ticket === latest.current) setConfig(cfg);
    } catch (e) {
      if (ticket === latest.current) {
        setConfig(null);
        setError(errorMessage(e));
      }
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setConfig(null);
    if (project) void load(project);
    return () => {
      latest.current++;
    };
  }, [project, load]);

  const savedSettings = (file: SettingsFile) =>
    setConfig((c) => c && { ...c, settings: c.settings.map((s) => (s.scope === file.scope ? file : s)) });

  const header = (
    <SectionHeader
      title="Projects"
      description="Permission rules, hooks, commands and skills that Claude Code reads from a project."
    />
  );

  if (!project) {
    return (
      <>
        {header}
        <div className="rounded-xl border border-dashed border-line-strong bg-card/40">
          <EmptyState
            icon={<FolderCog />}
            title="No projects yet"
            description="Start an agent in a folder and it shows up here, with its permission rules, hooks and commands."
          />
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="min-w-[220px] max-w-[420px] flex-1">
          <Select
            aria-label="Project"
            value={project}
            onValueChange={setProject}
            options={options.map((p) => ({
              value: p,
              label: basename(p) || p,
              description: prettyPath(p),
            }))}
          />
        </div>
        <span className="min-w-0 flex-1 truncate text-[12px] text-steel" title={project}>
          {prettyPath(project)}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void attempt("Couldn't open the folder", () => api.openPath(config?.root ?? project))}
        >
          <FolderOpen /> Open folder
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Reload from disk"
          disabled={loading}
          onClick={() => void load(project)}
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} />
        </Button>
      </div>

      <p className="mb-4 flex flex-wrap items-center gap-x-1.5 text-[12.5px] leading-[20px] text-muted">
        CLAUDE.md and AGENTS.md now live in
        <button
          type="button"
          onClick={() => openToolkit("instructions", project)}
          className="inline-flex items-center gap-1 rounded font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <Wrench className="h-3.5 w-3.5" /> Tools &amp; instructions
        </button>
        for this project.
      </p>

      <Segmented<Tab>
        aria-label="Project settings"
        className="mb-5"
        value={tab}
        onChange={setTab}
        options={[
          {
            value: "permissions",
            label: (
              <>
                <Shield className="h-3.5 w-3.5" /> Permissions
                {config && (
                  <span className="tabular text-[11px] text-steel">
                    {config.settings.reduce((n, s) => n + ruleCount(s.rules), 0)}
                  </span>
                )}
              </>
            ),
          },
          {
            value: "automation",
            label: (
              <>
                <Workflow className="h-3.5 w-3.5" /> Hooks, commands &amp; skills
              </>
            ),
          },
        ]}
      />

      {error ? (
        <div className="rounded-xl border border-err/30 bg-err/8 px-4 py-3">
          <InlineError message={error} />
          <Button size="sm" variant="secondary" className="mt-3" onClick={() => void load(project)}>
            <RefreshCw /> Try again
          </Button>
        </div>
      ) : !config ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading project files">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : tab === "permissions" ? (
        <ProjectPermissions project={project} files={config.settings} onSaved={savedSettings} />
      ) : (
        <ProjectAutomation
          hooks={config.settings.flatMap((s) => s.hooks)}
          commands={config.commands}
          skills={config.skills}
          files={Object.fromEntries(config.settings.filter((s) => s.exists).map((s) => [s.scope, s.path]))}
        />
      )}
    </>
  );
}
