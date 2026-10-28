import { Minus, RotateCw, Search, Square, Unplug, Users, Workflow, X } from "lucide-react";
import { PROVIDERS } from "@/lib/providers";
import type { Account } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi, type View } from "@/store/ui";
import { modKey } from "@/lib/utils";
import { windowAction } from "@/lib/window";
import { AccountAvatar } from "./AccountAvatar";
import { AppMark } from "./AppMark";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { COMPACT_TITLEBAR_QUERY } from "@/lib/layout";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip } from "./ui/tooltip";
import { UsageMeters } from "./UsageMeter";
import { UpdatePill } from "./UpdatePill";
import { ProviderGlyph } from "./ProviderGlyph";
import { SubagentList } from "./agent/SubagentList";
import { useSubagentOverview } from "./agent/useSubagents";

const VIEW_LABEL: Record<View, string> = {
  agents: "Agents",
  mission: "Mission Control",
  inbox: "Inbox",
  compare: "Compare",
  triage: "Needs you",
  schedules: "Schedules",
  usage: "Usage",
  accounts: "Accounts",
  settings: "Settings",
};

export function TitleBar({ minimal = false }: { minimal?: boolean }) {
  const platform = useApp((s) => s.platform);
  const accounts = useApp((s) => s.accounts);
  const view = useUi((s) => s.view);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const mac = platform === "macos";
  const compact = useMediaQuery(COMPACT_TITLEBAR_QUERY);
  const connectionLost = useApp((s) => s.connectionLost);

  return (
    <>
      <header
        data-tauri-drag-region
        className="texture relative z-30 flex h-10 shrink-0 items-center border-b border-line bg-panel edge"
        style={{ paddingLeft: mac ? 78 : 12 }}
      >
        <div
          data-tauri-drag-region
          className={cn("flex min-w-0 shrink items-center gap-2", compact ? "w-auto" : "w-[200px]")}
        >
          <AppMark size={18} />
          <span data-tauri-drag-region className="text-[13px] font-semibold tracking-[-0.01em] text-fg">
            Armada
          </span>
          {!minimal && (
            <>
              <span data-tauri-drag-region className="text-line-strong max-[599px]:hidden">
                /
              </span>
              <span data-tauri-drag-region className="truncate text-[12.5px] text-muted max-[599px]:hidden">
                {VIEW_LABEL[view]}
              </span>
            </>
          )}
        </div>

        <div data-tauri-drag-region className="flex min-w-0 flex-1 justify-center px-4">
          {!minimal && compact ? (
            <Tooltip content="Search and commands" shortcut={[modKey, "K"]} side="bottom">
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                aria-label="Open command palette"
                className="flex h-7 w-7 items-center justify-center rounded-lg border border-line bg-base/60 text-steel transition-colors hover:border-line-strong hover:text-fg"
              >
                <Search className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          ) : (
            !minimal && (
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="group flex h-[26px] w-full min-w-0 max-w-[380px] items-center gap-2 rounded-lg border border-line bg-base/60 px-2.5 text-[12.5px] text-steel transition-colors hover:border-line-strong hover:bg-base hover:text-muted"
                aria-label="Open command palette"
              >
                <Search className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">Search agents, actions, history…</span>
                <span className="ml-auto flex shrink-0 gap-0.5">
                  <Kbd>{modKey}</Kbd>
                  <Kbd>K</Kbd>
                </span>
              </button>
            )
          )}
        </div>

        <div data-tauri-drag-region className="flex h-full shrink-0 items-center gap-3">
          {!minimal && <SubagentsIndicator compact={compact} />}
          {!minimal && <UpdatePill />}
          {!minimal && accounts.length > 0 && <AccountSwitcher accounts={accounts} stacked={compact} />}
          {!mac && <WindowControls />}
        </div>
      </header>
      {connectionLost !== null && <ConnectionLostBanner error={connectionLost} />}
    </>
  );
}

/** "N sub-agents" across all agents; opens a list grouped by agent. Hidden when none are running. */
function SubagentsIndicator({ compact }: { compact: boolean }) {
  const { total, agents } = useSubagentOverview();
  if (total === 0) return null;
  const label = `${total} sub-agent${total === 1 ? "" : "s"} running`;
  return (
    <Popover>
      <Tooltip content={label} side="bottom">
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className="flex h-6 items-center gap-1.5 rounded-full border border-accent/30 bg-accent/[0.08] px-2 text-[11.5px] text-accent transition-colors hover:border-accent/50 hover:bg-accent/15"
          >
            <Workflow className="h-3 w-3" />
            <span className="tabular">{total}</span>
            {!compact && <span>sub-agent{total === 1 ? "" : "s"}</span>}
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="w-[360px] p-1.5">
        <div className="max-h-[420px] overflow-y-auto">
          {agents.map(({ agent, runs }) => (
            <section key={agent.id} className="pb-1.5 last:pb-0">
              <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5">
                <ProviderGlyph provider={agent.provider} customAgentId={agent.customAgentId} size="xs" />
                <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-muted">{agent.title}</span>
              </div>
              <PopoverClose asChild>
                <div>
                  <SubagentList runs={runs} onSelect={(r) => useUi.getState().revealItem(agent.id, r.itemId)} />
                </div>
              </PopoverClose>
            </section>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Persistent: without the event stream every view silently goes stale. */
function ConnectionLostBanner({ error }: { error: string }) {
  return (
    <div
      role="alert"
      className="relative z-20 flex shrink-0 items-center gap-2.5 border-b border-err/30 bg-err/[0.08] px-3 py-1.5 text-[12.5px]"
    >
      <Unplug className="h-3.5 w-3.5 shrink-0 text-err" />
      <span className="font-medium text-err">Lost connection to Armada core</span>
      <span className="min-w-0 flex-1 truncate text-muted" title={error}>
        Live updates are paused. {error}
      </span>
      <Button size="xs" variant="secondary" onClick={() => window.location.reload()}>
        <RotateCw className="!h-3 !w-3" /> Reload
      </Button>
    </div>
  );
}

function WindowControls() {
  const btn =
    "flex h-10 w-11 items-center justify-center text-steel transition-colors hover:bg-raised hover:text-fg [&_svg]:h-3.5 [&_svg]:w-3.5";
  return (
    <div className="flex h-full items-center">
      <button type="button" aria-label="Minimize" className={btn} onClick={() => void windowAction("minimize")}>
        <Minus />
      </button>
      <button type="button" aria-label="Maximize" className={btn} onClick={() => void windowAction("toggleMaximize")}>
        <Square className="!h-3 !w-3" />
      </button>
      <button
        type="button"
        aria-label="Close"
        className={`${btn} hover:!bg-err hover:!text-white`}
        onClick={() => void windowAction("close")}
      >
        <X />
      </button>
    </div>
  );
}

function AccountSwitcher({ accounts, stacked }: { accounts: Account[]; stacked: boolean }) {
  const setView = useUi((s) => s.setView);
  const signedIn = accounts.filter((a) => a.status?.loggedIn).length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center rounded-full pl-1 transition-transform active:scale-[0.97]"
          aria-label={`Accounts: ${signedIn} of ${accounts.length} signed in`}
        >
          {(stacked ? accounts.slice(0, 1) : accounts.slice(0, 5)).map((a, i) => (
            <span key={a.id} className="-ml-1 first:ml-0" style={{ zIndex: 10 - i }}>
              <AccountAvatar account={a} size={22} showProvider={false} compact />
            </span>
          ))}
          {stacked && accounts.length > 1 && (
            <span className="relative z-20 -ml-1 flex h-[22px] min-w-[22px] items-center justify-center rounded-full border border-line-strong bg-raised px-1.5 text-[10px] font-medium text-muted tabular ring-2 ring-panel">
              +{accounts.length - 1}
            </span>
          )}
          {!stacked && accounts.length > 5 && (
            <span className="-ml-1 flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-raised px-1 text-[10px] text-muted ring-2 ring-panel">
              +{accounts.length - 5}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-0">
        <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
          <span className="text-[12.5px] font-semibold">Accounts</span>
          <span className="text-[11.5px] text-steel tabular">
            {signedIn} of {accounts.length} signed in
          </span>
        </div>
        <ul className="max-h-[360px] overflow-y-auto p-1.5">
          {accounts.map((a) => (
            <li key={a.id} className="rounded-lg px-2 py-2">
              <div className="flex items-center gap-2.5">
                <AccountAvatar account={a} size={26} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium">
                    {a.name} <span className="font-normal text-steel">· {PROVIDERS[a.provider].short}</span>
                  </div>
                  <div className={cn("truncate text-[11px]", a.status?.loggedIn ? "text-steel" : "text-warn")}>
                    {a.status?.loggedIn ? (a.status.label ?? "Signed in") : "Not signed in"}
                    {a.authKind === "api_key" && a.status?.loggedIn && " · billed per token"}
                  </div>
                </div>
                <span
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", a.status?.loggedIn ? "bg-ok" : "bg-warn")}
                  aria-hidden
                />
              </div>
              <UsageMeters usage={a.usage} compact className="mt-2 pl-[36px]" />
            </li>
          ))}
        </ul>
        <div className="border-t border-line p-1.5">
          <PopoverClose asChild>
            <button
              type="button"
              onClick={() => setView("accounts")}
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[12.5px] text-muted transition-colors hover:bg-gunmetal hover:text-fg"
            >
              <Users className="h-3.5 w-3.5" /> Manage accounts
            </button>
          </PopoverClose>
        </div>
      </PopoverContent>
    </Popover>
  );
}
