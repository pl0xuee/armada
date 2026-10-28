import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { attempt } from "@/lib/actions";
import { api } from "@/lib/api";
import type { Agent, ConfigOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuCheckItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Tooltip } from "../ui/tooltip";

/** Compact dropdown for one of the agent's session config options (model, mode, effort…). */
export function ConfigSelect({
  agent,
  option,
  compact,
}: {
  agent: Agent;
  option: ConfigOption;
  /** Narrow composer: shorter label. */
  compact?: boolean;
}) {
  const current = option.options.find((o) => o.value === option.currentValue);
  const warn = option.currentValue === "bypassPermissions" || option.currentValue === "never";
  return (
    <DropdownMenu>
      <Tooltip content={option.name}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${option.name}: ${current?.name ?? option.currentValue}`}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-muted transition-colors hover:bg-raised hover:text-fg data-[state=open]:bg-raised data-[state=open]:text-fg",
              warn && "text-warn hover:text-warn",
            )}
          >
            <span className={cn("truncate", compact ? "max-w-[96px]" : "max-w-[130px]")}>
              {current?.name ?? option.currentValue}
            </span>
            <ChevronDown className="h-3 w-3 text-steel" />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" side="top" className="w-64">
        <DropdownMenuLabel>{option.name}</DropdownMenuLabel>
        {option.options.map((o) => (
          <DropdownMenuCheckItem
            key={o.value}
            checked={o.value === option.currentValue}
            description={o.description}
            onSelect={() =>
              void attempt(`Couldn't change ${option.name.toLowerCase()}`, () =>
                api.setAgentConfig(agent.id, option.id, o.value),
              )
            }
          >
            {o.name}
          </DropdownMenuCheckItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function setOption(agent: Agent, option: ConfigOption, value: string) {
  void attempt(`Couldn't change ${option.name.toLowerCase()}`, () => api.setAgentConfig(agent.id, option.id, value));
}

/** "+" menu holding session options that don't fit inline on narrow composers. */
export function ConfigOverflowMenu({ agent, options }: { agent: Agent; options: ConfigOption[] }) {
  if (options.length === 0) return null;
  return (
    <DropdownMenu>
      <Tooltip content="More session options">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="More session options"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg data-[state=open]:bg-raised data-[state=open]:text-fg"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuLabel>Session options</DropdownMenuLabel>
        {options.map((opt) => {
          const current = opt.options.find((o) => o.value === opt.currentValue);
          return (
            <DropdownMenuSub key={opt.id}>
              <DropdownMenuSubTrigger>
                <span>{opt.name}</span>
                <span className="ml-auto max-w-[110px] truncate pl-3 text-[11.5px] text-steel">
                  {current?.name ?? opt.currentValue}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {opt.options.map((o) => (
                  <DropdownMenuCheckItem
                    key={o.value}
                    checked={o.value === opt.currentValue}
                    description={o.description}
                    onSelect={() => setOption(agent, opt, o.value)}
                  >
                    {o.name}
                  </DropdownMenuCheckItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
