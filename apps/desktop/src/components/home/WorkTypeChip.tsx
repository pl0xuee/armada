import { Gauge } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import {
  availableWorkTypes,
  KEEP,
  readWorkChoice,
  resolveWorkChoice,
  saveWorkChoice,
  WORK_TYPES,
  type WorkChoice,
} from "@/lib/modelGuide";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import {
  DropdownMenu,
  DropdownMenuCheckItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Tooltip } from "../ui/tooltip";

const MODEL_NAME: Record<string, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable" };

/**
 * The kind of work a new Claude agent is for (picks its model and effort). Starts on the last pick;
 * with none yet, on Opus at medium for a new install and on "my usual" for anyone who has chosen
 * their own model or effort before, so nothing changes without being asked.
 */
export function useWorkChoice(): [WorkChoice, (c: WorkChoice) => void, ReturnType<typeof availableWorkTypes>] {
  const agents = useApp((s) => s.agents);
  const [stored, setStored] = useState(readWorkChoice);
  const [claudeDefaults, setClaudeDefaults] = useState<Record<string, string> | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api
      .configDefaults()
      .then((d) => live && setClaudeDefaults(d.claude ?? {}))
      .catch(() => live && setClaudeDefaults({}));
    return () => {
      live = false;
    };
  }, []);
  const available = useMemo(() => availableWorkTypes(Object.values(agents)), [agents]);
  const choice = resolveWorkChoice(stored, claudeDefaults, available);
  return [
    choice,
    (c) => {
      saveWorkChoice(c);
      setStored(c);
    },
    available,
  ];
}

/** Chip + menu for the kind of work. Shown for Claude launches only. */
export function WorkTypeChip({
  value,
  onChange,
  available,
  compact = false,
  className,
}: {
  value: WorkChoice;
  onChange: (c: WorkChoice) => void;
  available: ReturnType<typeof availableWorkTypes>;
  compact?: boolean;
  className?: string;
}) {
  const current = WORK_TYPES.find((w) => w.id === value);
  const label = current?.label ?? "My usual model";
  return (
    <DropdownMenu>
      <Tooltip
        content={
          current
            ? `Starts on ${MODEL_NAME[current.model] ?? current.model} at ${current.effort} effort. You can change both in the message box later.`
            : "Starts on the model and effort you used last."
        }
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Kind of work: ${label}`}
            className={cn(
              "inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-line bg-base/50 px-2 text-caption text-fg/90 transition-colors hover:border-line-strong hover:bg-raised data-[state=open]:border-line-strong data-[state=open]:bg-raised",
              className,
            )}
          >
            <Gauge className="h-3.5 w-3.5 shrink-0 text-steel" />
            <span className={cn("truncate", compact && "sr-only")}>{label}</span>
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" side="bottom" className="w-72">
        <DropdownMenuLabel>What is this agent for?</DropdownMenuLabel>
        {available.map((w) => (
          <DropdownMenuCheckItem
            key={w.id}
            checked={value === w.id}
            description={`${MODEL_NAME[w.model] ?? w.model} · ${w.blurb}`}
            onSelect={() => onChange(w.id)}
          >
            {w.label}
          </DropdownMenuCheckItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuCheckItem
          checked={value === KEEP}
          description="The model and effort you used last"
          onSelect={() => onChange(KEEP)}
        >
          My usual model
        </DropdownMenuCheckItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
