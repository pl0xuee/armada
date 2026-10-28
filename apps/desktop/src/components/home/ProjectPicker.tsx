import { Check, ChevronRight, Compass, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { discoverProjectsOnce } from "@/lib/launchDefaults";
import { basename, cn, errorMessage, prettyPath } from "@/lib/utils";
import { Skeleton } from "../ui/skeleton";
import { Tooltip } from "../ui/tooltip";

function FolderChip({ path, active, onPick }: { path: string; active: boolean; onPick: (p: string) => void }) {
  return (
    <Tooltip content={prettyPath(path)}>
      <button
        type="button"
        onClick={() => onPick(path)}
        aria-pressed={active}
        className={cn(
          "inline-flex h-6 max-w-[200px] items-center gap-1 rounded-full border px-2.5 text-[11.5px] transition-colors",
          active
            ? "border-accent/50 bg-accent/10 text-accent"
            : "border-line bg-card text-muted hover:border-line-strong hover:text-fg",
        )}
      >
        {active && <Check className="h-3 w-3 shrink-0" />}
        <span className="truncate">{basename(path)}</span>
      </button>
    </Tooltip>
  );
}

/**
 * Recent project chips plus a collapsible "Found on this computer" list of git repos
 * (discovered lazily, filterable).
 */
export function ProjectPicker({
  value,
  onChange,
  recent,
  defaultOpen = false,
  limitRecent = 6,
}: {
  value: string;
  onChange: (path: string) => void;
  recent: string[];
  defaultOpen?: boolean;
  limitRecent?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [found, setFound] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const requested = useRef(false);

  const load = useCallback(() => {
    requested.current = true;
    setError(null);
    discoverProjectsOnce()
      .then(setFound)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);

  // Discovery is lazy: it starts the first time the section is opened.
  useEffect(() => {
    if (open && !requested.current) load();
  }, [open, load]);

  const extra = useMemo(() => {
    const seen = new Set(recent.slice(0, limitRecent));
    const q = filter.trim().toLowerCase();
    return (found ?? []).filter((p) => !seen.has(p) && (!q || p.toLowerCase().includes(q)));
  }, [found, recent, limitRecent, filter]);

  return (
    <div className="mt-2 space-y-2">
      {recent.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Recent projects">
          {recent.slice(0, limitRecent).map((p) => (
            <FolderChip key={p} path={p} active={value === p} onPick={onChange} />
          ))}
        </div>
      )}
      <div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-1.5 text-[11.5px] text-muted transition-colors hover:text-fg"
        >
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform duration-150", open && "rotate-90")} />
          <Compass className="h-3.5 w-3.5 text-steel" />
          Found on this computer
          {found && <span className="tabular text-steel">{found.length}</span>}
        </button>
        {open && (
          <div className="mt-2 rounded-xl border border-line bg-base/40 p-2">
            {error ? (
              <div className="flex items-center gap-2 px-1 py-1 text-[12px] text-err">
                <span className="min-w-0 flex-1 truncate">Couldn't look for projects: {error}</span>
                <button
                  type="button"
                  onClick={load}
                  className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-muted hover:bg-raised hover:text-fg"
                >
                  <RefreshCw className="h-3 w-3" /> Retry
                </button>
              </div>
            ) : found === null ? (
              <div className="flex flex-wrap gap-1.5 p-0.5" aria-label="Looking for projects">
                {["w-[90px]", "w-[120px]", "w-[80px]", "w-[110px]"].map((w) => (
                  <Skeleton key={w} className={cn("h-6 rounded-full", w)} />
                ))}
              </div>
            ) : found.length === 0 ? (
              <p className="px-1 py-1 text-[12px] text-steel">No git repositories found in your home folder.</p>
            ) : (
              <>
                {found.length > 8 && (
                  <div className="relative mb-2">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-steel" />
                    <input
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Filter repositories"
                      aria-label="Filter repositories"
                      spellCheck={false}
                      className="h-7 w-full rounded-md border border-line bg-base/60 pl-7 pr-2 text-[12px] text-fg placeholder:text-steel focus:border-accent/50 focus:outline-none"
                    />
                  </div>
                )}
                <div
                  className="flex max-h-[104px] flex-wrap gap-1.5 overflow-y-auto"
                  role="group"
                  aria-label="Found projects"
                >
                  {extra.map((p) => (
                    <FolderChip key={p} path={p} active={value === p} onPick={onChange} />
                  ))}
                  {extra.length === 0 && (
                    <span className="px-1 text-[12px] text-steel">
                      {filter ? `No repositories match “${filter}”.` : "All found projects are listed above."}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
