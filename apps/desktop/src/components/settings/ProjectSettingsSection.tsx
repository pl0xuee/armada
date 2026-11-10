import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { ruleCount, type ProjectConfig, type SettingsFile } from "@/lib/projectConfig";
import { errorMessage } from "@/lib/utils";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { ProjectAutomation } from "./ProjectAutomation";
import { InlineError } from "./ProjectNotice";
import { ProjectPermissions } from "./ProjectPermissions";

/**
 * Settings → Projects, Permissions and Hooks tabs: the permission rules, hooks and slash commands
 * Claude Code reads from a project. Skills have their own tab.
 */
export function ProjectRules({ project, show }: { project: string; show: "permissions" | "automation" }) {
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
    void load(project);
    return () => {
      latest.current++;
    };
  }, [project, load]);

  const savedSettings = (file: SettingsFile) =>
    setConfig((c) => c && { ...c, settings: c.settings.map((s) => (s.scope === file.scope ? file : s)) });

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-caption text-muted">
          {show === "permissions"
            ? `What agents may do in this project without asking.${
                config ? ` ${config.settings.reduce((n, s) => n + ruleCount(s.rules), 0)} rules.` : ""
              }`
            : "Hooks and slash commands this project gives its agents."}
        </p>
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
      ) : show === "permissions" ? (
        <ProjectPermissions project={project} files={config.settings} onSaved={savedSettings} />
      ) : (
        <ProjectAutomation
          hooks={config.settings.flatMap((s) => s.hooks)}
          commands={config.commands}
          files={Object.fromEntries(config.settings.filter((s) => s.exists).map((s) => [s.scope, s.path]))}
        />
      )}
    </>
  );
}
