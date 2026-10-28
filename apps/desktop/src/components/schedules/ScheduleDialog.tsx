import { CalendarClock, Check, FolderOpen, GitBranch, ShieldCheck, TriangleAlert, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { CUSTOM_ACCOUNT_ID, PROVIDER_ORDER, PROVIDERS } from "@/lib/providers";
import { DAY_LONG, DAY_SHORT, nextRun, normalizeDays, runsOn, untilLabel, whenLabel, WEEKDAYS } from "@/lib/schedules";
import type { Account, Provider, Schedule } from "@/lib/types";
import { basename, cn, errorMessage, prettyPath } from "@/lib/utils";
import { pickFolder } from "@/lib/window";
import { useFreshNow } from "./useFreshNow";
import { useApp } from "@/store/app";
import { ProviderGlyph } from "../ProviderGlyph";
import { TemplatePicker } from "../TemplatePicker";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "../ui/dialog";
import { Input, Label, Textarea } from "../ui/input";
import { Spinner } from "../ui/misc";
import { Segmented } from "../ui/segmented";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";

function defaultAccount(accounts: Account[], provider: Provider): Account | undefined {
  const mine = accounts.filter((a) => a.provider === provider);
  return mine.find((a) => a.status?.loggedIn) ?? mine[0];
}

/** Create/edit dialog. `schedule === null` closes it; an object with `id: ""` creates. */
export function ScheduleDialog({
  schedule,
  onClose,
  onSaved,
}: {
  schedule: Schedule | null;
  onClose: () => void;
  onSaved: (s: Schedule) => void;
}) {
  // Keep rendering the last schedule while the dialog animates out.
  const last = useRef<Schedule | null>(schedule);
  if (schedule) last.current = schedule;
  const shown = last.current;
  const creating = shown?.id === "";
  return (
    <Dialog open={schedule !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={creating ? "New schedule" : "Edit schedule"}
        description="The agent starts on its own at the chosen time, with this prompt."
        className="w-[min(640px,calc(100vw-32px))]"
      >
        {shown && (
          <ScheduleForm
            key={`${shown.id || "new"}-${shown.updatedAt}`}
            initial={shown}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Blank schedule with sensible defaults from settings/accounts. */
export function blankSchedule(): Schedule {
  const { accounts, settings } = useApp.getState();
  return {
    id: "",
    name: "",
    enabled: true,
    customAgentId: null,
    provider: "claude",
    accountId: defaultAccount(accounts, "claude")?.id ?? "",
    projectPath: settings?.recentProjects[0] ?? "",
    prompt: "",
    // Unattended runs start isolated and asking, whatever the interactive defaults are.
    worktree: true,
    time: "09:00",
    days: [...WEEKDAYS],
    lastRunAt: null,
    lastAgentId: null,
    lastError: null,
    permissionMode: "ask",
    updatedAt: 0,
  };
}

function ScheduleForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: Schedule;
  onClose: () => void;
  onSaved: (s: Schedule) => void;
}) {
  const accounts = useApp((s) => s.accounts);
  const recent = useApp((s) => s.settings?.recentProjects ?? []);
  const defaultMode = useApp((s) => s.settings?.defaultPermissionMode ?? "ask");
  const [draft, setDraft] = useState<Schedule>(initial);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const now = useFreshNow();

  useEffect(() => {
    const t = setTimeout(() => nameRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  const set = <K extends keyof Schedule>(key: K, value: Schedule[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const providerAccounts = useMemo(
    () => accounts.filter((a) => a.provider === draft.provider),
    [accounts, draft.provider],
  );
  const account = accounts.find((a) => a.id === draft.accountId);

  const customAgents = useApp((s) => s.settings?.customAgents);
  // Enabled custom agents, plus the one this schedule already uses (even if since disabled).
  const enabledCustom = useMemo(
    () => (customAgents ?? []).filter((a) => a.enabled || a.id === initial.customAgentId),
    [customAgents, initial.customAgentId],
  );
  const customAgent = draft.provider === "custom" ? customAgents?.find((a) => a.id === draft.customAgentId) : undefined;
  const runtimeValue = draft.provider === "custom" ? `custom:${draft.customAgentId ?? ""}` : draft.provider;

  /** Built-ins use a signed-in account; custom ACP agents run on the implicit system-custom account. */
  const chooseRuntime = (value: string) => {
    if (value.startsWith("custom:")) {
      const id = value.slice("custom:".length);
      setDraft((d) => ({ ...d, provider: "custom", customAgentId: id, accountId: CUSTOM_ACCOUNT_ID }));
    } else {
      const p = value as Provider;
      setDraft((d) => ({ ...d, provider: p, customAgentId: null, accountId: defaultAccount(accounts, p)?.id ?? "" }));
    }
  };

  const toggleDay = (day: number) =>
    setDraft((d) => {
      const current = d.days.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : d.days;
      const next = current.includes(day) ? current.filter((x) => x !== day) : [...current, day];
      // Keep at least one day; an empty set would read as "every day".
      if (next.length === 0) return d;
      return { ...d, days: normalizeDays(next) };
    });

  const browse = async () => {
    const p = await pickFolder(draft.projectPath || undefined);
    if (p) set("projectPath", p);
  };

  const insertTemplate = (text: string) => {
    setDraft((d) => ({ ...d, prompt: d.prompt.trim() ? `${d.prompt.trimEnd()}\n\n${text}` : text }));
    requestAnimationFrame(() => promptRef.current?.focus());
  };

  const next = draft.enabled ? nextRun(draft, new Date(now)) : null;
  const isEveryDay = draft.days.length === 0;
  const isWeekdays = draft.days.join(",") === WEEKDAYS.join(",");

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await api.saveSchedule({
        ...draft,
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        projectPath: draft.projectPath.trim(),
        days: normalizeDays(draft.days),
      });
      onSaved(saved);
      toast.success(initial.id ? "Schedule updated" : "Schedule created", { description: saved.name });
      onClose();
    } catch (e) {
      toast.error("Couldn't save schedule", { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <DialogBody className="space-y-4 pt-2">
        {initial.id && initial.lastError && (
          <div
            role="note"
            className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[12.5px]"
          >
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
            <span className="min-w-0 text-muted">
              <span className="font-medium text-fg">The last run didn't start.</span>{" "}
              <span className="selectable break-words">{initial.lastError}</span>
            </span>
          </div>
        )}
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <div>
            <Label htmlFor="sch-name">Name</Label>
            <Input
              id="sch-name"
              ref={nameRef}
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. Nightly dependency audit"
            />
          </div>
          <label className="flex h-9 items-center gap-2 text-[12.5px] text-muted">
            Enabled
            <Switch checked={draft.enabled} onCheckedChange={(v) => set("enabled", v)} aria-label="Enabled" />
          </label>
        </div>

        <div>
          <Label>Agent</Label>
          <div className="-mx-1 overflow-x-auto px-1 pb-0.5">
            <Segmented
              aria-label="Agent runtime"
              value={runtimeValue}
              onChange={chooseRuntime}
              options={[
                ...PROVIDER_ORDER.map((p) => ({
                  value: p as string,
                  label: (
                    <>
                      <ProviderGlyph provider={p} size="xs" />
                      {PROVIDERS[p].short}
                    </>
                  ),
                })),
                ...enabledCustom.map((c) => ({
                  value: `custom:${c.id}`,
                  label: (
                    <>
                      <ProviderGlyph provider="custom" customAgentId={c.id} size="xs" />
                      <span className="max-w-[120px] truncate">{c.name}</span>
                    </>
                  ),
                })),
              ]}
            />
          </div>
          <div className="mt-2">
            {draft.provider === "custom" ? (
              <div className="flex h-9 items-center gap-2 rounded-lg border border-dashed border-line-strong px-3 text-[12.5px] text-steel">
                <span className="text-muted">No sign-in needed</span>
                {customAgent && (
                  <>
                    <span className="text-line-strong">·</span>
                    <span className="min-w-0 truncate font-mono text-[11.5px]">
                      {[customAgent.command, ...customAgent.args].join(" ")}
                    </span>
                  </>
                )}
                {customAgent && !customAgent.enabled && (
                  <span className="shrink-0 text-warn">· disabled in Settings → Agents</span>
                )}
                {!customAgent && <span className="text-warn">This custom agent no longer exists</span>}
              </div>
            ) : (
              <Select
                aria-label="Account"
                value={draft.accountId || undefined}
                onValueChange={(v) => set("accountId", v)}
                disabled={providerAccounts.length === 0}
                placeholder={
                  providerAccounts.length ? "Choose account" : `No ${PROVIDERS[draft.provider].short} accounts`
                }
                options={providerAccounts.map((a) => ({
                  value: a.id,
                  label: (
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: a.color }} />
                      <span className="truncate">{a.name}</span>
                      <span className={cn("text-[11px]", a.status?.loggedIn ? "text-steel" : "text-warn")}>
                        {a.status?.loggedIn ? (a.status.label ?? "Signed in") : "Not signed in"}
                      </span>
                    </span>
                  ),
                }))}
              />
            )}
          </div>
          {account && account.status && !account.status.loggedIn && (
            <p className="mt-2 flex items-center gap-1.5 text-[12px] text-warn">
              <TriangleAlert className="h-3.5 w-3.5" /> {account.name} isn't signed in, so scheduled runs will fail
              until it is.
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="sch-project">Project folder</Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <FolderOpen className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-steel" />
              <Input
                id="sch-project"
                value={draft.projectPath}
                onChange={(e) => set("projectPath", e.target.value)}
                placeholder="/path/to/project"
                className="pl-9 font-mono text-[12.5px]"
              />
            </div>
            <Button variant="secondary" className="h-9" onClick={() => void browse()}>
              Browse…
            </Button>
          </div>
          {recent.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {recent.slice(0, 6).map((p) => {
                const on = draft.projectPath === p;
                return (
                  <button
                    key={p}
                    type="button"
                    title={prettyPath(p)}
                    aria-pressed={on}
                    onClick={() => set("projectPath", p)}
                    className={cn(
                      "inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-[11.5px] transition-colors",
                      on
                        ? "border-accent/50 bg-accent/10 text-accent"
                        : "border-line bg-card text-muted hover:border-line-strong hover:text-fg",
                    )}
                  >
                    {on && <Check className="h-3 w-3" />}
                    {basename(p)}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <Label htmlFor="sch-prompt" className="mb-0">
              Prompt
            </Label>
            <TemplatePicker onInsert={insertTemplate} side="bottom" align="end" />
          </div>
          <Textarea
            id="sch-prompt"
            ref={promptRef}
            value={draft.prompt}
            onChange={(e) => set("prompt", e.target.value)}
            placeholder="What should the agent do each time it runs?"
            className="min-h-[96px]"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-[148px_1fr]">
          <div>
            <div className="mb-1.5 flex h-5 items-center">
              <Label htmlFor="sch-time" className="mb-0">
                Time
              </Label>
            </div>
            <Input
              id="sch-time"
              type="time"
              value={draft.time}
              onChange={(e) => set("time", e.target.value)}
              className="tabular"
            />
          </div>
          <div>
            <div className="mb-1.5 flex h-5 items-center justify-between">
              <span className="text-xs font-medium text-muted" id="sch-days-label">
                Days
              </span>
              <div className="flex gap-1">
                <QuickDays active={isEveryDay} onClick={() => set("days", [])}>
                  Every day
                </QuickDays>
                <QuickDays active={isWeekdays} onClick={() => set("days", [...WEEKDAYS])}>
                  Weekdays
                </QuickDays>
              </div>
            </div>
            <div role="group" aria-labelledby="sch-days-label" className="grid grid-cols-7 gap-1">
              {DAY_SHORT.map((label, day) => {
                const on = runsOn(draft.days, day);
                return (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={on}
                    aria-label={DAY_LONG[day]}
                    onClick={() => toggleDay(day)}
                    className={cn(
                      "h-9 rounded-lg border text-[12px] font-medium transition-[border-color,background-color,color,transform] active:scale-[0.97]",
                      on
                        ? "border-accent/50 bg-accent/12 text-accent"
                        : "border-line bg-base/50 text-steel hover:border-line-strong hover:text-fg",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <label className="flex items-center gap-2 text-[12.5px] text-fg">
            <Switch
              checked={draft.worktree}
              onCheckedChange={(v) => set("worktree", v)}
              aria-label="Isolated git worktree"
            />
            <GitBranch className="h-3.5 w-3.5 text-steel" />
            Isolated worktree
            <span className="text-[11.5px] text-steel">(each run gets its own branch)</span>
          </label>
          <div className="flex items-center gap-2 text-[12.5px] text-fg">
            <span className="flex items-center gap-1.5">
              {(draft.permissionMode ?? defaultMode) === "auto" ? (
                <Zap className="h-3.5 w-3.5 text-accent" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5 text-steel" />
              )}
              Starts in
            </span>
            <Segmented
              size="sm"
              aria-label="Permission mode for runs"
              value={draft.permissionMode ?? "default"}
              onChange={(v) => set("permissionMode", v === "default" ? null : v)}
              options={[
                { value: "default", label: `Default (${defaultMode === "auto" ? "Auto" : "Ask"})` },
                { value: "auto", label: "Auto" },
                { value: "ask", label: "Ask" },
              ]}
            />
          </div>
        </div>
        {(draft.permissionMode ?? defaultMode) === "auto" && (
          <p role="note" className="-mt-2 text-[11.5px] text-warn">
            Runs unattended with auto-approval; changes to the project between runs aren't reviewed.
          </p>
        )}

        <div
          aria-live="polite"
          className="flex items-center gap-2.5 rounded-xl border border-line bg-base/40 px-3 py-2.5 text-[12.5px]"
        >
          <CalendarClock className={cn("h-4 w-4 shrink-0", next ? "text-accent" : "text-steel")} />
          {!draft.enabled ? (
            <span className="text-muted">Paused. It won't run until you enable it.</span>
          ) : next ? (
            <span className="text-muted">
              Next run <span className="font-medium text-fg">{whenLabel(next, now)}</span>
              <span className="text-steel">, {untilLabel(next, now)}</span>
            </span>
          ) : (
            <span className="text-warn">Pick a valid time to see the next run.</span>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Check />}
          {initial.id ? "Save changes" : "Create schedule"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function QuickDays({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-5 rounded-md px-1.5 text-[11px] font-medium transition-colors",
        active ? "bg-accent/12 text-accent" : "text-steel hover:bg-raised hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
