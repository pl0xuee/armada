import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

export interface PickerFile {
  path: string;
  additions: number;
  deletions: number;
}

/** Most rows rendered at once; typing narrows the rest, so thousands of files stay cheap. */
const MAX_ROWS = 100;

/** Searchable "jump to file" combobox for narrow windows: type to filter, arrows move, Enter jumps. */
export function FilePicker({
  files,
  selected,
  onSelect,
}: {
  files: readonly PickerFile[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
  }, [files, query]);
  const rows = matches.length > MAX_ROWS ? matches.slice(0, MAX_ROWS) : matches;

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (path: string) => {
    setOpen(false);
    onSelect(path);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Jump to file"
          aria-haspopup="listbox"
          className="flex h-8 min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border border-line bg-base/60 px-3 text-left font-mono text-[12px] text-fg transition-colors hover:border-line-strong focus:border-accent/60 focus:outline-none focus:ring-3 focus:ring-accent/15"
        >
          <span className="min-w-0 truncate">{selected ?? "Jump to file"}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-steel" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(520px,calc(100vw-16px))] p-2">
        <Input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="file-picker-list"
          aria-activedescendant={rows[active] ? `file-picker-${active}` : undefined}
          aria-label="Filter files"
          placeholder={`Filter ${files.length.toLocaleString()} files…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(rows.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter" && rows[active]) {
              e.preventDefault();
              choose(rows[active].path);
            }
          }}
          className="h-8 font-mono text-[12px]"
        />
        <div ref={listRef} id="file-picker-list" role="listbox" aria-label="Files" className="mt-2 max-h-[min(320px,50vh)] overflow-y-auto">
          {rows.map((f, i) => (
            <div
              key={f.path}
              id={`file-picker-${i}`}
              data-idx={i}
              role="option"
              aria-selected={f.path === selected}
              onMouseMove={() => active !== i && setActive(i)}
              onClick={() => choose(f.path)}
              className={cn(
                "flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 font-mono text-[12px] text-fg",
                i === active && "bg-gunmetal",
                f.path === selected && "text-accent",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{f.path}</span>
              <span className="shrink-0 text-ok">+{f.additions}</span>
              <span className="shrink-0 text-err">−{f.deletions}</span>
            </div>
          ))}
          {rows.length === 0 && <p className="px-2 py-3 text-[12px] text-steel">No files match.</p>}
          {matches.length > rows.length && (
            <p className="px-2 py-2 text-[11.5px] text-steel">
              Showing {rows.length} of {matches.length.toLocaleString()} — keep typing to narrow.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
