import { FileText, FolderOpen, Plug, Puzzle, Shield, Workflow } from "lucide-react";
import { useEffect, useMemo } from "react";
import { McpSection } from "@/components/settings/McpSection";
import { ProjectRules } from "@/components/settings/ProjectSettingsSection";
import { SectionHeader } from "@/components/settings/SettingRow";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { attempt } from "@/lib/actions";
import { api } from "@/lib/api";
import { projectChoices } from "@/lib/projectConfig";
import { scopeServers, type ToolkitTab } from "@/lib/toolkit";
import type { McpServer } from "@/lib/types";
import { basename, prettyPath } from "@/lib/utils";
import { useApp } from "@/store/app";
import { draftKey, useProjectSettings } from "@/store/projectSettings";
import { useToolkit } from "@/store/toolkit";
import { InstructionsPanel } from "./InstructionsPanel";
import { SkillsPanel } from "./SkillsPanel";

/** Settings → Projects: instructions, MCP servers, skills, permission rules and hooks, for one project at a time. */
export function ToolsHub({ servers }: { servers: McpServer[] }) {
  const tab = useToolkit((s) => s.tab);
  const setTab = useToolkit((s) => s.setTab);
  const agents = useApp((s) => s.agents);
  const recent = useApp((s) => s.settings?.recentProjects);
  const chosen = useProjectSettings((s) => s.project);
  const setProject = useProjectSettings((s) => s.setProject);
  const drafts = useProjectSettings((s) => s.drafts);

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

  // Leaving the tab for a project that has nothing to show there is never a dead end.
  const needsProject = tab === "instructions" || tab === "permissions" || tab === "automation";
  useEffect(() => {
    if (!project && needsProject) setTab("mcp");
  }, [project, needsProject, setTab]);

  const unsaved = project
    ? ["CLAUDE.md", "AGENTS.md"].some((f) => draftKey(project, f as "CLAUDE.md") in drafts)
    : false;
  const scoped = scopeServers(servers, project);

  return (
    <>
      <SectionHeader
        title="Projects"
        description="What your agents know, can use and may do in each project. No config files to edit."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="min-w-[220px] max-w-[420px] flex-1">
          <Select
            aria-label="Project"
            value={project ?? undefined}
            onValueChange={setProject}
            placeholder="No projects yet"
            disabled={options.length === 0}
            options={options.map((p) => ({
              value: p,
              label: basename(p) || p,
              description: prettyPath(p),
            }))}
          />
        </div>
        <span className="min-w-0 flex-1 truncate text-caption text-steel" title={project ?? undefined}>
          {project ? prettyPath(project) : "Start an agent in a folder to see its instructions here."}
        </span>
        {project && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void attempt("Couldn't open the folder", () => api.openPath(project))}
          >
            <FolderOpen /> Open folder
          </Button>
        )}
      </div>

      <Segmented<ToolkitTab>
        aria-label="Project settings"
        className="mb-5"
        value={tab}
        onChange={setTab}
        options={[
          {
            value: "instructions",
            disabled: !project,
            label: (
              <>
                <FileText className="h-3.5 w-3.5" /> Instructions
                {unsaved && (
                  <span className="h-1.5 w-1.5 rounded-full bg-warn" role="img" aria-label="unsaved changes" />
                )}
              </>
            ),
          },
          {
            value: "mcp",
            label: (
              <>
                <Plug className="h-3.5 w-3.5" /> MCP
                <span className="tabular text-micro text-steel">{scoped.global.length + scoped.project.length}</span>
              </>
            ),
          },
          {
            value: "skills",
            label: (
              <>
                <Puzzle className="h-3.5 w-3.5" /> Skills
              </>
            ),
          },
          {
            value: "permissions",
            disabled: !project,
            label: (
              <>
                <Shield className="h-3.5 w-3.5" /> Permissions
              </>
            ),
          },
          {
            value: "automation",
            disabled: !project,
            label: (
              <>
                <Workflow className="h-3.5 w-3.5" /> Hooks
              </>
            ),
          },
        ]}
      />

      {tab === "instructions" && project ? (
        <InstructionsPanel project={project} />
      ) : tab === "mcp" ? (
        <McpSection servers={servers} project={project} />
      ) : tab === "skills" ? (
        <SkillsPanel project={project} />
      ) : (tab === "permissions" || tab === "automation") && project ? (
        <ProjectRules project={project} show={tab} />
      ) : null}
    </>
  );
}
