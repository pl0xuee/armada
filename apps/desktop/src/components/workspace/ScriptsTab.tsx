import { Play, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { api } from "@/lib/api";
import type { Agent, ProjectScript } from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { openTerminal } from "@/store/workspace";

export function ScriptsTab({ agent }: { agent: Agent }) {
  const [scripts, setScripts] = useState<ProjectScript[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setScripts(null);
    setError(null);
    api
      .workspaceScripts(agent.id)
      .then(setScripts)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [agent.id]);
  useEffect(load, [load]);

  const run = (s: ProjectScript) =>
    openTerminal(agent.id, { scriptId: s.id, title: `${s.source} ${s.name}` }).catch((e: unknown) =>
      toast.error("Couldn't run the script", { description: errorMessage(e) }),
    );

  const groups = new Map<string, ProjectScript[]>();
  for (const s of scripts ?? []) groups.set(s.source, [...(groups.get(s.source) ?? []), s]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="text-[11.5px] text-steel">Detected in this agent's folder</span>
        <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label="Rescan scripts" onClick={load}>
          <RefreshCw />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {error ? (
          <p className="text-[12.5px] text-err">{error}</p>
        ) : scripts === null ? (
          <div className="flex items-center gap-2 text-[12.5px] text-steel">
            <Spinner className="h-3.5 w-3.5" /> Looking for scripts…
          </div>
        ) : scripts.length === 0 ? (
          <p className="py-4 text-center text-[12.5px] text-steel">
            No scripts found (package.json, Cargo, Makefile, justfile, pytest, Go).
          </p>
        ) : (
          [...groups].map(([source, list]) => (
            <div key={source} className="mb-2.5 last:mb-0">
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-steel">{source}</div>
              <ul className="grid grid-cols-1 gap-1 @2xl:grid-cols-2">
                {list.map((s) => (
                  <li
                    key={s.id}
                    className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-card/60 py-1 pl-2.5 pr-1"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-medium">{s.name}</div>
                      <div className="truncate font-mono text-[11px] text-steel">{s.command}</div>
                    </div>
                    <Button size="xs" variant="secondary" onClick={() => void run(s)} aria-label={`Run ${s.command}`}>
                      <Play className="!h-3 !w-3" /> Run
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
