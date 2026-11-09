import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { attempt } from "@/lib/actions";
import { api } from "@/lib/api";
import type { Agent, ConfigOption } from "@/lib/types";
import { isRememberableOption } from "@/lib/configMemory";
import { cn } from "@/lib/utils";
import { useIdentity } from "@/hooks/useIdentity";
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
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const remembered = agent.provider !== "local" && isRememberableOption(option);
  const warn = option.currentValue === "bypassPermissions" || option.currentValue === "never";
  const toggle = onOff(option);
  if (toggle) {
    const on = option.currentValue === toggle.on;
    return (
      <Tooltip
        content={`${option.name} is ${on ? "on" : "off"}. Click to turn it ${on ? "off" : "on"}${remembered ? `. New ${identity.short} agents start with your last choice` : ""}`}
      >
        <button
          type="button"
          aria-pressed={on}
          aria-label={option.name}
          onClick={() => setOption(agent, option, on ? toggle.off : toggle.on)}
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-meta transition-colors",
            on ? "bg-accent/10 text-accent hover:bg-accent/15" : "text-steel hover:bg-raised hover:text-fg",
          )}
        >
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", on ? "bg-accent" : "bg-line-strong")} aria-hidden />
          <span className={cn("truncate", compact ? "max-w-[96px]" : "max-w-[130px]")}>{option.name}</span>
        </button>
      </Tooltip>
    );
  }
  const label = current?.name ?? option.currentValue;
  // "Default" or "None" says nothing on its own: name the option too.
  const bare = /^(default|none)\b/i.test(label);
  return (
    <DropdownMenu>
      <Tooltip content={option.name}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${option.name}: ${current?.name ?? option.currentValue}`}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-meta text-muted transition-colors hover:bg-raised hover:text-fg data-[state=open]:bg-raised data-[state=open]:text-fg",
              warn && "text-warn hover:text-warn",
            )}
          >
            <span className={cn("truncate", compact ? "max-w-[96px]" : "max-w-[130px]")}>
              {bare && <span className="text-steel">{option.name}: </span>}
              {label}
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
            onSelect={() => setOption(agent, option, o.value)}
          >
            {o.name}
          </DropdownMenuCheckItem>
        ))}
        {remembered && (
          <p className="border-t border-line-strong px-2.5 pb-1 pt-2 text-micro leading-snug text-steel">
            New {identity.short} agents start with your last choice
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The values of an option that is only On or Off, shown as a named switch instead of a menu. */
export function onOff(option: ConfigOption): { on: string; off: string } | null {
  if (option.options.length !== 2) return null;
  const on = option.options.find((o) => o.name.trim().toLowerCase() === "on");
  const off = option.options.find((o) => o.name.trim().toLowerCase() === "off");
  return on && off ? { on: on.value, off: off.value } : null;
}

function setOption(agent: Agent, option: ConfigOption, value: string) {
  void attempt(`Couldn't change ${option.name.toLowerCase()}`, () => api.setAgentConfig(agent.id, option.id, value));
}

/** "+" menu holding session options that don't fit inline on narrow composers. */
export function ConfigOverflowMenu({ agent, options }: { agent: Agent; options: ConfigOption[] }) {
  const identity = useIdentity(agent.provider, agent.customAgentId);
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
          const toggle = onOff(opt);
          if (toggle) {
            const on = opt.currentValue === toggle.on;
            return (
              <DropdownMenuCheckItem
                key={opt.id}
                checked={on}
                description={
                  agent.provider !== "local" && isRememberableOption(opt)
                    ? `New ${identity.short} agents start with your last choice`
                    : undefined
                }
                onSelect={() => setOption(agent, opt, on ? toggle.off : toggle.on)}
              >
                {opt.name}
              </DropdownMenuCheckItem>
            );
          }
          return (
            <DropdownMenuSub key={opt.id}>
              <DropdownMenuSubTrigger>
                <span>{opt.name}</span>
                <span className="ml-auto max-w-[110px] truncate pl-3 text-meta text-steel">
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
