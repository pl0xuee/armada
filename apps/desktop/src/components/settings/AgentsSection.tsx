import { openExternal } from "@/lib/external";
import { ACCOUNT_COLORS } from "@/lib/providers";
import { Bot, CircleCheck, CircleX, ExternalLink, Pencil, Plug, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ColorSwatches } from "@/components/accounts/ColorSwatches";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { Spinner } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { monogram } from "@/lib/identity";
import type { CustomAgent } from "@/lib/types";
import { cn, errorMessage, uuid } from "@/lib/utils";
import { useApp } from "@/store/app";
import { cleanKeyValues, KeyValueEditor, validateKeyValues, type KeyValueRow } from "./KeyValueEditor";
import { SectionHeader } from "./SettingRow";
import { FieldError } from "./TemplatesSection";

const ACP_AGENTS_URL = "https://agentclientprotocol.com/overview/agents";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Preset {
  id: string;
  name: string;
  command: string;
  args: string[];
  color: string;
  blurb: string;
}

const PRESETS: Preset[] = [
  {
    id: "gemini",
    name: "Gemini CLI",
    command: "gemini",
    args: ["--acp"],
    color: ACCOUNT_COLORS[0],
    blurb: "Google's coding agent",
  },
  {
    id: "goose",
    name: "Goose",
    command: "goose",
    args: ["acp"],
    color: ACCOUNT_COLORS[4],
    blurb: "Open-source agent by Block",
  },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: ["acp"],
    color: ACCOUNT_COLORS[6],
    blurb: "Terminal-native agent",
  },
  { id: "other", name: "", command: "", args: [], color: ACCOUNT_COLORS[3], blurb: "Anything that speaks ACP" },
];

type Draft = Omit<CustomAgent, "id"> & { id: string | null };

function fromPreset(p: Preset): Draft {
  return { id: null, name: p.name, command: p.command, args: p.args, env: [], color: p.color, enabled: true };
}

async function saveAgents(customAgents: CustomAgent[], failure: string): Promise<boolean> {
  const settings = useApp.getState().settings;
  if (!settings) return false;
  try {
    await useApp.getState().setSettings({ ...settings, customAgents });
    return true;
  } catch (e) {
    toast.error(failure, { description: errorMessage(e) });
    return false;
  }
}

/** Color tile with the agent's initials, matching ProviderGlyph's look. */
function AgentMonogram({ name, color, size = 32 }: { name: string; color: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center border font-semibold leading-none tracking-tight"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        fontSize: Math.round(size * 0.38),
        color,
        background: `linear-gradient(180deg, color-mix(in srgb, ${color} 20%, var(--bg-2)), color-mix(in srgb, ${color} 9%, var(--bg-1)))`,
        borderColor: `color-mix(in srgb, ${color} 32%, var(--border))`,
        boxShadow: "inset 0 1px 0 var(--edge-strong)",
      }}
    >
      {name.trim() ? monogram(name) : <Bot className="h-[45%] w-[45%]" />}
    </span>
  );
}

export function AgentsSection({ agents }: { agents: CustomAgent[] }) {
  const [editing, setEditing] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<CustomAgent | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const running = useApp((s) => s.agents);
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of Object.values(running)) {
      if (a.customAgentId && !a.archived) m.set(a.customAgentId, (m.get(a.customAgentId) ?? 0) + 1);
    }
    return m;
  }, [running]);

  const toggle = async (agent: CustomAgent, on: boolean) => {
    setToggling(agent.id);
    await saveAgents(
      agents.map((a) => (a.id === agent.id ? { ...a, enabled: on } : a)),
      on ? `Couldn't enable ${agent.name}` : `Couldn't disable ${agent.name}`,
    );
    setToggling(null);
  };

  const remove = async (agent: CustomAgent) => {
    const ok = await saveAgents(
      agents.filter((a) => a.id !== agent.id),
      `Couldn't remove ${agent.name}`,
    );
    setDeleting(null);
    if (ok) toast(`Removed ${agent.name}`);
  };

  return (
    <>
      <SectionHeader
        title="Agents"
        description="Armada can run any agent that speaks the Agent Client Protocol, side by side with Claude, Codex and Grok."
        right={<AddMenu onPick={(p) => setEditing(fromPreset(p))} />}
      />

      {agents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong bg-card/40 pb-6">
          <EmptyState
            icon={<Bot />}
            title="No custom agents yet"
            description="Start from a preset or point Armada at any ACP-compatible command. You can test the connection before saving."
            className="pb-6"
          />
          <PresetGrid onPick={(p) => setEditing(fromPreset(p))} />
        </div>
      ) : (
        <>
          <ul
            aria-label="Custom agents"
            className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card edge"
          >
            {agents.map((a) => (
              <AgentRow
                key={a.id}
                agent={a}
                count={usage.get(a.id) ?? 0}
                busy={toggling === a.id}
                onToggle={(on) => void toggle(a, on)}
                onEdit={() => setEditing({ ...a })}
                onDelete={() => setDeleting(a)}
              />
            ))}
          </ul>
          <p className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 px-0.5 text-[12px] text-steel">
            Enabled agents appear as providers in New agent, Compare and Schedules.
            <a
              href={ACP_AGENTS_URL}
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 whitespace-nowrap text-muted underline decoration-line-strong underline-offset-2 hover:text-fg"
            >
              Find ACP agents <ExternalLink className="h-3 w-3" />
            </a>
          </p>
        </>
      )}

      <AgentDialog
        key={editing ? (editing.id ?? `new-${editing.command}`) : "closed"}
        draft={editing}
        agents={agents}
        onClose={() => setEditing(null)}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        danger
        title={`Remove ${deleting?.name ?? "agent"}?`}
        description={
          deleting && (usage.get(deleting.id) ?? 0) > 0
            ? "Agents already using it keep their history, but they can't be resumed or started again until you add it back."
            : "You can add it again any time."
        }
        confirmLabel="Remove agent"
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      />
    </>
  );
}

function AddMenu({ onPick }: { onPick: (p: Preset) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" className="shrink-0">
          <Plus /> Add agent
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Presets</DropdownMenuLabel>
        {PRESETS.map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => onPick(p)} className="h-auto min-h-8 gap-2.5 py-1.5">
            <AgentMonogram name={p.name} color={p.color} size={20} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{p.name || "Other ACP agent"}</span>
              <span className="truncate text-[11px] text-steel">
                {p.command ? `${p.command} ${p.args.join(" ")}` : p.blurb}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void openExternal(ACP_AGENTS_URL)}>
          <ExternalLink /> Browse ACP agents
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PresetGrid({ onPick }: { onPick: (p: Preset) => void }) {
  return (
    <div className="mx-auto grid max-w-[560px] grid-cols-2 gap-2 px-6">
      {PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onPick(p)}
          className="flex items-center gap-3 rounded-xl border border-line bg-card px-3 py-2.5 text-left transition-[transform,border-color,background-color] duration-150 hover:-translate-y-px hover:border-line-strong hover:bg-raised/60 active:scale-[0.98] edge"
        >
          <AgentMonogram name={p.name} color={p.color} size={30} />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium">{p.name || "Other ACP agent"}</span>
            <span className="block truncate font-mono text-[11px] text-steel">
              {p.command ? `${p.command} ${p.args.join(" ")}` : p.blurb}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

function AgentRow({
  agent,
  count,
  busy,
  onToggle,
  onEdit,
  onDelete,
}: {
  agent: CustomAgent;
  count: number;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const shownArgs = agent.args.slice(0, 4);
  return (
    <li className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-raised/40">
      <span className={cn("transition-opacity", !agent.enabled && "opacity-50")}>
        <AgentMonogram name={agent.name} color={agent.color} />
      </span>
      <button
        type="button"
        onClick={onEdit}
        className="min-w-0 flex-1 rounded-md text-left"
        aria-label={`Edit ${agent.name}`}
      >
        <span className="flex items-center gap-2">
          <span className={cn("truncate text-[13px] font-medium", agent.enabled ? "text-fg" : "text-muted")}>
            {agent.name}
          </span>
          {count > 0 && (
            <span className="shrink-0 text-[11.5px] text-steel">
              · {count} agent{count === 1 ? "" : "s"}
            </span>
          )}
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted">
          <span className="shrink-0 font-mono text-fg/85">{agent.command}</span>
          {shownArgs.map((a, i) => (
            <span
              key={i}
              className="min-w-0 max-w-[180px] truncate rounded border border-line bg-base/50 px-1 font-mono text-[10.5px] text-muted"
            >
              {a}
            </span>
          ))}
          {agent.args.length > shownArgs.length && (
            <span className="shrink-0 text-[10.5px] text-steel">+{agent.args.length - shownArgs.length}</span>
          )}
          {agent.env.length > 0 && (
            <span className="shrink-0 text-steel">
              · {agent.env.length} env var{agent.env.length === 1 ? "" : "s"}
            </span>
          )}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <Tooltip content="Edit">
          <Button size="icon-sm" variant="ghost" aria-label={`Edit ${agent.name}`} onClick={onEdit}>
            <Pencil className="!h-3.5 !w-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content="Remove">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${agent.name}`}
            onClick={onDelete}
            className="hover:text-err"
          >
            <Trash2 className="!h-3.5 !w-3.5" />
          </Button>
        </Tooltip>
      </div>
      <span className="flex w-[34px] shrink-0 justify-end">
        {busy ? (
          <Spinner className="h-3.5 w-3.5" />
        ) : (
          <Switch
            checked={agent.enabled}
            onCheckedChange={onToggle}
            aria-label={`${agent.enabled ? "Disable" : "Enable"} ${agent.name}`}
          />
        )}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------- add / edit dialog

type TestState =
  { kind: "idle" } | { kind: "running" } | { kind: "ok"; message: string } | { kind: "fail"; message: string };

function AgentDialog({ draft, agents, onClose }: { draft: Draft | null; agents: CustomAgent[]; onClose: () => void }) {
  const editingId = draft?.id ?? null;
  const [name, setName] = useState(draft?.name ?? "");
  const [command, setCommand] = useState(draft?.command ?? "");
  const [args, setArgs] = useState((draft?.args ?? []).join("\n"));
  const [env, setEnv] = useState<KeyValueRow[]>(() => (draft?.env ?? []).map((kv, i) => ({ ...kv, key: `env-${i}` })));
  const [color, setColor] = useState(draft?.color ?? ACCOUNT_COLORS[3]);
  const [enabled, setEnabled] = useState(draft?.enabled ?? true);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const counter = useRef(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const commandRef = useRef<HTMLInputElement>(null);
  const testRun = useRef(0);

  const show = (f: string) => attempted || touched[f];
  const touch = (f: string) => () => setTouched((t) => ({ ...t, [f]: true }));
  // Any change to how the agent is launched makes a previous test result stale.
  const invalidate = () => setTest((t) => (t.kind === "idle" ? t : { kind: "idle" }));

  const envErrors = useMemo(
    () => validateKeyValues(env, ENV_NAME, "Use letters, digits and underscores, not starting with a digit."),
    [env],
  );
  const argList = args
    .split("\n")
    .map((a) => a.trim())
    .filter(Boolean);
  const errors = {
    name: !name.trim()
      ? "Give the agent a name."
      : agents.some((a) => a.id !== editingId && a.name.trim().toLowerCase() === name.trim().toLowerCase())
        ? "Another agent already uses this name."
        : null,
    command: !command.trim() ? "Enter the command that starts the agent." : null,
  };
  const valid = !errors.name && !errors.command && Object.keys(envErrors).length === 0;
  const commandHasSpaces = /\s/.test(command.trim()) && argList.length === 0;

  const build = (): CustomAgent => ({
    id: editingId ?? uuid(),
    name: name.trim(),
    command: command.trim(),
    args: argList,
    env: cleanKeyValues(env),
    color,
    enabled,
  });

  const runTest = async () => {
    if (!command.trim()) {
      setTouched((t) => ({ ...t, command: true }));
      commandRef.current?.focus();
      return;
    }
    const run = ++testRun.current;
    setTest({ kind: "running" });
    try {
      const message = await api.testCustomAgent(build());
      if (run === testRun.current) setTest({ kind: "ok", message });
    } catch (e) {
      if (run === testRun.current) setTest({ kind: "fail", message: errorMessage(e) });
    }
  };

  const submit = async () => {
    setAttempted(true);
    if (!valid || saving) return;
    setSaving(true);
    const agent = build();
    const list = editingId ? agents.map((a) => (a.id === editingId ? agent : a)) : [...agents, agent];
    const ok = await saveAgents(list, editingId ? `Couldn't save ${agent.name}` : `Couldn't add ${agent.name}`);
    setSaving(false);
    if (ok) {
      toast.success(editingId ? `${agent.name} saved` : `${agent.name} added`, {
        description: agent.enabled ? "Pick it as the provider when you start a new agent." : "It's disabled for now.",
      });
      onClose();
    }
  };

  const errClass = "border-err/60 focus:border-err/70 focus:ring-err/15";

  return (
    <Dialog open={draft !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={editingId ? `Edit ${draft?.name}` : draft?.name ? `Add ${draft.name}` : "Add ACP agent"}
        description="Armada starts the command and talks to it over the Agent Client Protocol."
        className="w-[min(620px,calc(100vw-32px))]"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (name ? commandRef : nameRef).current?.focus();
        }}
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogBody className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="pt-[22px]">
                <AgentMonogram name={name} color={color} size={36} />
              </div>
              <div className="min-w-0 flex-1">
                <Label htmlFor="ca-name">Name</Label>
                <Input
                  id="ca-name"
                  ref={nameRef}
                  value={name}
                  maxLength={40}
                  placeholder="e.g. Gemini CLI"
                  aria-invalid={show("name") && !!errors.name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={touch("name")}
                  className={cn(show("name") && errors.name && errClass)}
                />
                {show("name") && errors.name && <FieldError>{errors.name}</FieldError>}
              </div>
              <label className="flex shrink-0 cursor-default items-center gap-2 pt-[30px] text-[12.5px] text-muted">
                Enabled
                <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
              </label>
            </div>

            <div>
              <span className="mb-1.5 block text-xs font-medium text-muted">Color</span>
              <ColorSwatches value={color} onChange={setColor} aria-label="Agent color" />
            </div>

            <div>
              <Label htmlFor="ca-command">Command</Label>
              <Input
                id="ca-command"
                ref={commandRef}
                value={command}
                placeholder="gemini"
                spellCheck={false}
                aria-invalid={show("command") && !!errors.command}
                onChange={(e) => {
                  setCommand(e.target.value);
                  invalidate();
                }}
                onBlur={touch("command")}
                className={cn("font-mono text-[12.5px]", show("command") && errors.command && errClass)}
              />
              {show("command") && errors.command ? (
                <FieldError>{errors.command}</FieldError>
              ) : commandHasSpaces ? (
                <p className="mt-1.5 text-[12px] text-warn">
                  Put each argument on its own line below so paths with spaces stay intact.
                </p>
              ) : (
                <p className="mt-1.5 text-[12px] text-steel">A program on your PATH, or an absolute path.</p>
              )}
            </div>

            <div>
              <Label htmlFor="ca-args">Arguments</Label>
              <Textarea
                id="ca-args"
                value={args}
                onChange={(e) => {
                  setArgs(e.target.value);
                  invalidate();
                }}
                placeholder={"--acp"}
                className="min-h-[72px] font-mono text-[12px]"
                spellCheck={false}
              />
              <p className="mt-1.5 text-[12px] text-steel">One argument per line. Blank lines are ignored.</p>
            </div>

            <div>
              <span className="mb-1.5 block text-xs font-medium text-muted">Environment variables</span>
              <KeyValueEditor
                label="Environment variable"
                rows={env}
                onChange={(rows) => {
                  setEnv(rows);
                  invalidate();
                }}
                errors={envErrors}
                showErrors
                namePlaceholder="GEMINI_API_KEY"
                valuePlaceholder="value"
                addLabel="Add variable"
                newKey={() => `new-${++counter.current}`}
              />
            </div>

            <TestPanel state={test} onRun={() => void runTest()} />
          </DialogBody>
          <DialogFooter>
            <a
              href={ACP_AGENTS_URL}
              rel="noreferrer noopener"
              className="mr-auto inline-flex items-center gap-1 text-[12px] text-muted transition-colors hover:text-fg"
            >
              Which agents support ACP? <ExternalLink className="h-3 w-3" />
            </a>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!valid || saving}>
              {saving && <Spinner className="h-3.5 w-3.5 text-current" />}
              {editingId ? "Save changes" : "Add agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TestPanel({ state, onRun }: { state: TestState; onRun: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // The panel is the last thing in the dialog body: bring a fresh result into view.
  useEffect(() => {
    if (state.kind !== "ok" && state.kind !== "fail") return;
    const box = ref.current?.closest<HTMLElement>(".overflow-y-auto");
    box?.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  }, [state]);
  return (
    <div ref={ref} className="rounded-xl border border-line bg-base/40 p-3">
      <div className="flex items-center gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-raised text-steel">
          <Plug className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">Connection test</div>
          <div className="text-[12px] text-muted">Starts the agent and runs the ACP handshake, then stops it.</div>
        </div>
        <Button type="button" size="sm" variant="secondary" onClick={onRun} disabled={state.kind === "running"}>
          {state.kind === "running" ? <Spinner className="h-3.5 w-3.5" /> : <Plug className="!h-3.5 !w-3.5" />}
          {state.kind === "running" ? "Testing…" : state.kind === "idle" ? "Test connection" : "Test again"}
        </Button>
      </div>
      <div aria-live="polite">
        {state.kind === "ok" && (
          <p className="mt-2.5 flex items-center gap-2 text-[12.5px] text-ok">
            <CircleCheck className="h-4 w-4 shrink-0" />
            <span className="min-w-0 truncate">
              Connected · <span className="font-mono text-[12px]">{state.message}</span>
            </span>
          </p>
        )}
        {state.kind === "fail" && (
          <div role="alert" className="mt-2.5 rounded-lg border border-err/30 bg-err/[0.07]">
            <div className="flex items-center gap-2 px-3 pt-2 text-[12.5px] font-medium text-err">
              <CircleX className="h-4 w-4 shrink-0" />
              Couldn't connect
            </div>
            <pre className="selectable max-h-40 overflow-auto whitespace-pre-wrap break-words px-3 pb-2.5 pt-1.5 font-mono text-[11.5px] leading-relaxed text-err/90">
              {state.message}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
