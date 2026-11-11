import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { useState, type ReactNode } from "react";
import { attempt } from "@/lib/actions";
import { api } from "@/lib/api";
import type { Agent, ConfigOption } from "@/lib/types";
import { isRememberableOption } from "@/lib/configMemory";
import { formatTokens } from "@/lib/format";
import { choiceHint, menuNote, switchNeedsNote } from "@/lib/modelGuide";
import { cn } from "@/lib/utils";
import { useIdentity } from "@/hooks/useIdentity";
import { ConfirmDialog } from "../ui/alert-dialog";
import { Button } from "../ui/button";
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
import { canCompact, compactContext } from "./compact";

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
  const [pick, switchDialog] = useOptionPicker(agent);
  const note = menuNote(agent, option);
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
            description={o.description || choiceHint(agent, option, o.value)}
            onSelect={() => pick(option, o.value)}
          >
            {o.name}
          </DropdownMenuCheckItem>
        ))}
        {(note || remembered) && (
          <div className="space-y-1 border-t border-line-strong px-2.5 pb-1 pt-2 text-micro leading-snug text-steel">
            {note && <p>{note}</p>}
            {remembered && <p>New {identity.short} agents start with your last choice</p>}
          </div>
        )}
      </DropdownMenuContent>
      {switchDialog}
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

/**
 * Picks an option's value. Changing a Claude agent's model on a long conversation first asks: the new
 * model has to re-read all of it once, so compacting first is cheaper. Render `dialog` next to the menu.
 */
function useOptionPicker(agent: Agent) {
  const [pending, setPending] = useState<{ option: ConfigOption; value: string } | null>(null);
  const pick = (option: ConfigOption, value: string) => {
    if (switchNeedsNote(agent, option, value)) setPending({ option, value });
    else setOption(agent, option, value);
  };
  const dialog = pending && (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && setPending(null)}
      title="Switch model now?"
      description={`This conversation is about ${formatTokens(agent.contextUsed ?? 0)} tokens long. The new model has to read all of it again, which costs more than a normal message. Switching at a natural break, or after compacting, is cheaper.`}
      confirmLabel="Switch anyway"
      onConfirm={() => {
        setOption(agent, pending.option, pending.value);
        setPending(null);
      }}
    >
      {canCompact(agent) && (
        <Button
          variant="secondary"
          onClick={() => {
            void compactContext(agent);
            setPending(null);
          }}
        >
          Compact first
        </Button>
      )}
    </ConfirmDialog>
  );
  return [pick, dialog] as const;
}

/** "+" menu holding session options that don't fit inline on narrow composers. */
export function ConfigOverflowMenu({
  agent,
  options,
  extra,
}: {
  agent: Agent;
  options: ConfigOption[];
  /** More entries after the options (the Helpers submenu). */
  extra?: ReactNode;
}) {
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const [pick, switchDialog] = useOptionPicker(agent);
  if (options.length === 0 && !extra) return null;
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
                    description={o.description || choiceHint(agent, opt, o.value)}
                    onSelect={() => pick(opt, o.value)}
                  >
                    {o.name}
                  </DropdownMenuCheckItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
        {extra}
      </DropdownMenuContent>
      {switchDialog}
    </DropdownMenu>
  );
}
