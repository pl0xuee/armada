import { ChevronDown } from "lucide-react";
import { attempt } from "@/lib/actions";
import { api } from "@/lib/api";
import type { Agent, ConfigOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuCheckItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Tooltip } from "../ui/tooltip";

/** Compact dropdown for one of the agent's session config options (model, mode, effort…). */
export function ConfigSelect({ agent, option }: { agent: Agent; option: ConfigOption }) {
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
            <span className="max-w-[130px] truncate">{current?.name ?? option.currentValue}</span>
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
