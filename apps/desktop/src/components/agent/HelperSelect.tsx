import { ChevronDown } from "lucide-react";
import { attempt } from "@/lib/actions";
import { agentHelpers, ownsHelpers } from "@/lib/agentHelpers";
import { api } from "@/lib/api";
import { HELPER_EFFORTS, HELPER_MODELS } from "@/lib/modelSetup";
import type { Agent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import {
  DropdownMenu,
  DropdownMenuCheckItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Tooltip } from "../ui/tooltip";

const short = (label: string) => label.replace(" (cheapest)", "");
const modelName = (v: string | null) =>
  v ? short(HELPER_MODELS.find((m) => m.value === v)?.label ?? v) : "Same model";
const effortName = (v: string) => HELPER_EFFORTS.find((e) => e.value === v)?.label ?? v;

/** "Sonnet · Low": what this agent's helpers run on now. */
export function helperSummary(agent: Agent, setting: Parameters<typeof agentHelpers>[1]) {
  const h = agentHelpers(agent, setting);
  return h.effort ? `${modelName(h.model)} · ${effortName(h.effort)}` : modelName(h.model);
}

function useSetting() {
  const model = useApp((st) => st.settings?.tokenSaver.subagentModel ?? null);
  const effort = useApp((st) => st.settings?.tokenSaver.subagentEffort ?? null);
  return { subagentModel: model, subagentEffort: effort };
}

function save(agent: Agent, model: string | null, effort: string | null) {
  void attempt("Couldn't change the helpers", () => api.setAgentSubagents(agent.id, model, effort));
}

/** Only Claude agents let Kvistcode choose what their helpers run on. */
export function hasHelperChoice(agent: Agent): boolean {
  return agent.provider === "claude";
}

/** The model and effort choices, for the inline menu and the overflow submenu. */
function HelperItems({ agent }: { agent: Agent }) {
  const setting = useSetting();
  const own = { model: agent.subagentModel ?? null, effort: agent.subagentEffort ?? null };
  const fromSettings = agentHelpers(undefined, setting);
  return (
    <>
      <DropdownMenuLabel>Helper model</DropdownMenuLabel>
      <DropdownMenuCheckItem
        checked={!own.model}
        description={`From Settings: ${modelName(fromSettings.model).toLowerCase()}`}
        onSelect={() => save(agent, null, own.effort)}
      >
        Default
      </DropdownMenuCheckItem>
      {HELPER_MODELS.map((m) => (
        <DropdownMenuCheckItem
          key={m.value}
          checked={own.model === m.value}
          onSelect={() => save(agent, m.value, own.effort)}
        >
          {m.value === "same" ? "Same as this agent" : m.label}
        </DropdownMenuCheckItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Helper effort</DropdownMenuLabel>
      <DropdownMenuCheckItem
        checked={!own.effort}
        description={`From Settings: ${fromSettings.effort ? effortName(fromSettings.effort).toLowerCase() : "Claude decides"}`}
        onSelect={() => save(agent, own.model, null)}
      >
        Default
      </DropdownMenuCheckItem>
      {HELPER_EFFORTS.map((e) => (
        <DropdownMenuCheckItem
          key={e.value}
          checked={own.effort === e.value}
          onSelect={() => save(agent, own.model, e.value)}
        >
          {e.label}
        </DropdownMenuCheckItem>
      ))}
      <p className="border-t border-line-strong px-2.5 pb-1 pt-2 text-micro leading-snug text-steel">
        Helpers are the sub-agents Claude starts for side tasks. A change applies to the next one this agent starts.
      </p>
    </>
  );
}

/** Composer chip: what this Claude agent's helpers run on, and a menu to change it for this agent. */
export function HelperSelect({ agent, compact }: { agent: Agent; compact?: boolean }) {
  const setting = useSetting();
  const summary = helperSummary(agent, setting);
  return (
    <DropdownMenu>
      <Tooltip content="Helpers: the model and effort for the sub-agents this agent starts">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Helpers: ${summary}`}
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-meta text-muted transition-colors hover:bg-raised hover:text-fg data-[state=open]:bg-raised data-[state=open]:text-fg minimal:h-7 minimal:rounded-lg minimal:px-2 minimal:text-small"
          >
            <span className={cn("truncate", compact ? "max-w-[110px]" : "max-w-[150px]")}>
              <span className="text-steel">Helpers: </span>
              {summary}
            </span>
            {ownsHelpers(agent) && <span className="h-1 w-1 shrink-0 rounded-full bg-accent" aria-hidden />}
            <ChevronDown className="h-3 w-3 text-steel" />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" side="top" className="w-64">
        <HelperItems agent={agent} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The same choices as a submenu of the composer's "More session options" menu. */
export function HelperSubmenu({ agent }: { agent: Agent }) {
  const setting = useSetting();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span>Helpers</span>
        <span className="ml-auto max-w-[110px] truncate pl-3 text-meta text-steel">
          {helperSummary(agent, setting)}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <HelperItems agent={agent} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
