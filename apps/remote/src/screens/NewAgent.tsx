import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AttachButton, AttachmentTray, usePhotoPicker } from "@/components/Attachments";
import { AccountDot, ProviderBadge } from "@/components/Identity";
import { Icon } from "@/components/Icon";
import { TopBar } from "@/components/TopBar";
import { Button, IconButton } from "@/components/ui";
import { errorMessage, newIdempotencyKey } from "@/lib/api";
import { cn } from "@/lib/cn";
import { createAgent } from "@/lib/controller";
import { basename } from "@/lib/format";
import { safeColor } from "@/lib/meta";
import { mergeAttachments } from "@/lib/attachments";
import { accountProblem, agentChoices, initialForm, saveLast, validate, type NewAgentForm } from "@/lib/newAgent";
import { goBack, navigate } from "@/lib/router";
import { useStore } from "@/lib/store";
import type { Attachment } from "@/lib/types";
import { EmptyState, ErrorState } from "./States";

const PROJECTS_SHOWN = 5;

export function NewAgent() {
  const accounts = useStore((s) => s.accounts);
  const customAgents = useStore((s) => s.customAgents);
  const projects = useStore((s) => s.projects);
  const templates = useStore((s) => s.templates);
  const defaultWorktree = useStore((s) => s.defaultWorktree);
  const defaultPermissionMode = useStore((s) => s.defaultPermissionMode);
  const stateStatus = useStore((s) => s.stateStatus);
  const stateError = useStore((s) => s.stateError);

  const choices = useMemo(() => agentChoices(Object.values(accounts), Object.values(customAgents)), [accounts, customAgents]);
  const [form, setForm] = useState<NewAgentForm | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [customPath, setCustomPath] = useState(false);
  const [allProjects, setAllProjects] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  // Initialise once the state (accounts, projects) is available.
  useEffect(() => {
    if (form || stateStatus !== "ready") return;
    const f = initialForm(choices, projects, defaultWorktree, undefined, defaultPermissionMode);
    setForm(f);
    setCustomPath(!projects.length);
  }, [choices, defaultPermissionMode, defaultWorktree, form, projects, stateStatus]);

  // One Idempotency-Key per distinct request: pressing Start again after a
  // timeout retries the same request (no duplicate agent); editing the form
  // makes it a new request.
  const requestKey = useRef<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const update = (patch: Partial<NewAgentForm>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setError(null);
    requestKey.current = null;
  };
  const picker = usePhotoPicker(form?.attachments ?? [], (list: Attachment[]) => {
    setForm((f) => (f ? { ...f, attachments: mergeAttachments(f.attachments, list).list } : f));
    requestKey.current = null;
  });

  let body: ReactNode;
  if (stateStatus === "error" && !choices.length) {
    body = <ErrorState title="Couldn't load your accounts" body={stateError} onRetry={() => location.reload()} />;
  } else if (!form) {
    body = <div className="skeleton mt-2 h-64 w-full rounded-2xl" aria-busy="true" aria-label="Loading" />;
  } else if (!choices.length) {
    body = (
      <EmptyState
        icon="user"
        title="No accounts yet"
        body="Add a Claude, Codex, Grok or custom agent account in Armada on your computer, then come back to start agents from here."
        action={{ label: "Back to agents", onClick: () => navigate({ name: "fleet" }, { replace: true }) }}
      />
    );
  } else {
    const choice = choices.find((c) => c.key === form.choiceKey) ?? null;
    const problem = accountProblem(choice?.accounts.find((a) => a.id === form.accountId));
    const visibleProjects = allProjects ? projects : projects.slice(0, PROJECTS_SHOWN);
    body = (
      <div className="space-y-6">
        <Section title="Agent">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Agent">
            {choices.map((c) => {
              const selected = c.key === form.choiceKey;
              return (
                <button
                  key={c.key}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() =>
                    update({
                      choiceKey: c.key,
                      accountId: c.accounts.some((a) => a.id === form.accountId) ? form.accountId : (c.accounts[0]?.id ?? null),
                    })
                  }
                  className={cn(
                    "press flex min-h-[60px] items-center gap-2.5 rounded-2xl border px-3 py-2.5 text-left",
                    selected ? "border-accent/60 bg-accent/[0.08] shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_30%,transparent)]" : "border-line bg-card",
                  )}
                >
                  <ProviderBadge agent={{ provider: c.provider, customAgentId: c.customAgentId }} size={34} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-semibold text-fg">{c.name}</span>
                    <span className="block truncate text-[12px] text-steel">
                      {c.accounts.length === 1 ? c.accounts[0].name : `${c.accounts.length} accounts`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {error?.field === "agent" && <FieldError>{error.message}</FieldError>}
          {choice && choice.accounts.length === 1 && problem && <AccountWarning>{problem}</AccountWarning>}
        </Section>

        {choice && choice.accounts.length > 1 && (
          <Section title="Account">
            <RadioList
              label="Account"
              items={choice.accounts.map((a) => ({
                key: a.id,
                selected: a.id === form.accountId,
                onSelect: () => update({ accountId: a.id }),
                content: (
                  <>
                    <AccountDot color={safeColor(a.color)} size={9} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] text-fg">{a.name}</span>
                      {accountProblem(a) ? (
                        <span className="block truncate text-[12.5px] text-warn">{a.loggedIn === false ? "Signed out" : "Needs attention"}</span>
                      ) : (
                        a.label && <span className="block truncate text-[12.5px] text-muted">{a.label}</span>
                      )}
                    </span>
                  </>
                ),
              }))}
            />
            {error?.field === "account" && <FieldError>{error.message}</FieldError>}
            {problem && <AccountWarning>{problem}</AccountWarning>}
          </Section>
        )}

        <Section title="Folder">
          {projects.length > 0 && (
            <RadioList
              label="Folder"
              items={[
                ...visibleProjects.map((p) => ({
                  key: p,
                  selected: !customPath && p === form.projectPath,
                  onSelect: () => {
                    setCustomPath(false);
                    update({ projectPath: p });
                  },
                  content: (
                    <>
                      <Icon name="folder" size={18} className="shrink-0 text-steel" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] text-fg">{basename(p)}</span>
                        <span className="block truncate font-mono text-[11.5px] text-steel" title={p}>
                          {p}
                        </span>
                      </span>
                    </>
                  ),
                })),
                {
                  key: "__other",
                  selected: customPath,
                  onSelect: () => {
                    setCustomPath(true);
                    update({ projectPath: "" });
                  },
                  content: (
                    <>
                      <Icon name="pencil" size={17} className="shrink-0 text-steel" />
                      <span className="flex-1 text-[15px] text-fg">Another folder…</span>
                    </>
                  ),
                },
              ]}
            />
          )}
          {projects.length > PROJECTS_SHOWN && !allProjects && (
            <button type="button" onClick={() => setAllProjects(true)} className="press mt-1 h-10 px-1 text-[13px] font-medium text-accent">
              Show all {projects.length} folders
            </button>
          )}
          {customPath && (
            <PathInput
              value={form.projectPath}
              onChange={(projectPath) => update({ projectPath })}
              invalid={error?.field === "folder"}
              autoFocus={projects.length > 0}
            />
          )}
          {error?.field === "folder" && <FieldError>{error.message}</FieldError>}
          <Toggle
            className="mt-3"
            checked={form.worktree}
            onChange={(worktree) => update({ worktree })}
            label="Isolated worktree"
            description="Works on its own git branch so your checkout stays untouched."
          />
        </Section>

        {form.permissionMode && (
          <Section title="Approvals">
            <Segmented
              label="Approvals"
              value={form.permissionMode}
              onChange={(permissionMode) => update({ permissionMode })}
              options={[
                { value: "auto", label: "Auto", hint: "Routine edits and commands run without asking" },
                { value: "ask", label: "Ask first", hint: "The agent asks before it changes anything" },
              ]}
            />
          </Section>
        )}

        <Section title="First message" hint="Optional: the agent starts and waits if you leave it empty.">
          {templates.length > 0 && (
            <div className="scroll-x -mx-1 mb-2 flex gap-1.5 px-1 pb-0.5" role="list" aria-label="Templates">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="listitem"
                  onClick={() => update({ prompt: form.prompt.trim() ? `${form.prompt.trimEnd()}\n\n${t.text}` : t.text })}
                  className="press inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line-strong bg-card px-3 text-[13px] text-fg"
                >
                  <Icon name="plus" size={14} className="text-steel" />
                  {t.name}
                </button>
              ))}
            </div>
          )}
          <div className="rounded-2xl border border-line-strong bg-card focus-within:border-accent/60 edge">
            <label htmlFor="new-agent-prompt" className="sr-only">
              First message
            </label>
            <textarea
              id="new-agent-prompt"
              value={form.prompt}
              onChange={(e) => update({ prompt: e.target.value })}
              rows={4}
              placeholder="What should it do?"
              className="block w-full resize-y rounded-2xl bg-transparent px-4 py-3 text-[16px] leading-[22px] text-fg outline-none placeholder:text-steel"
            />
            <div className="flex items-center gap-1 border-t border-line/70 px-1.5 py-0.5">
              {picker.element}
              <AttachButton picker={picker} />
              <button
                type="button"
                onClick={picker.openCamera}
                disabled={picker.busy || picker.full}
                className="press inline-flex h-11 items-center gap-1.5 rounded-xl px-2 text-[13px] font-medium text-muted disabled:opacity-40"
              >
                <Icon name="camera" size={18} />
                Take photo
              </button>
              <span className="ml-auto pr-2 text-[12.5px] text-steel">{form.attachments.length ? `${form.attachments.length} of 4` : ""}</span>
            </div>
          </div>
          <AttachmentTray
            attachments={form.attachments}
            onRemove={(i) => update({ attachments: form.attachments.filter((_, j) => j !== i) })}
            className="pt-3 pr-3"
          />
          <label htmlFor="new-agent-title" className="mt-4 mb-1.5 block text-[13px] font-medium text-muted">
            Name <span className="font-normal text-steel">(optional)</span>
          </label>
          <input
            id="new-agent-title"
            value={form.title}
            onChange={(e) => update({ title: e.target.value })}
            placeholder="Named from the first message if empty"
            maxLength={120}
            className="block h-12 w-full rounded-xl border border-line-strong bg-card px-3.5 text-[16px] text-fg outline-none placeholder:text-steel focus:border-accent/60"
          />
        </Section>

        <section>
          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            aria-expanded={advanced}
            className="press -mx-1 flex h-11 items-center gap-1.5 rounded-lg px-1 text-[12px] font-semibold tracking-[0.08em] text-steel uppercase"
          >
            Advanced
            <Icon name="chevronDown" size={15} className={cn("transition-transform duration-150", !advanced && "-rotate-90")} />
          </button>
          {advanced && (
            <div className="animate-fade">
              <label htmlFor="new-agent-model" className="mb-1.5 block text-[13px] font-medium text-muted">
                Model <span className="font-normal text-steel">(optional)</span>
              </label>
              <input
                id="new-agent-model"
                value={form.model}
                onChange={(e) => update({ model: e.target.value })}
                placeholder="The agent's default"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={200}
                className="block h-12 w-full rounded-xl border border-line-strong bg-card px-3.5 font-mono text-[16px] text-fg outline-none placeholder:font-sans placeholder:text-steel focus:border-accent/60"
              />
              <p className="mt-1.5 px-1 text-[12.5px] leading-snug text-steel">
                {choices.find((c) => c.key === form.choiceKey)?.provider === "local"
                  ? "The name of a model your local server has loaded."
                  : "A model id this agent understands (they differ per provider). You can also change the model after it starts."}
              </p>
            </div>
          )}
        </section>
      </div>
    );
  }

  const start = async () => {
    if (!form || submitting) return;
    const v = validate(form, choices);
    if (!v.ok) {
      setError({ message: v.error, field: v.field });
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      requestKey.current ??= newIdempotencyKey();
      const uploading = !!v.request.attachments?.length;
      if (uploading) setProgress(0);
      const id = await createAgent(v.request, requestKey.current, uploading ? setProgress : undefined);
      saveLast({ choiceKey: form.choiceKey!, accountId: v.request.accountId, projectPath: v.request.projectPath });
      navigate({ name: "agent", agentId: id }, { replace: true });
    } catch (e) {
      setError({ message: errorMessage(e) });
      setSubmitting(false);
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar left={<IconButton icon="chevronLeft" label="Back" onClick={goBack} />}>
        <h1 className="text-[17px] leading-tight font-semibold text-fg">New agent</h1>
      </TopBar>
      <main className="mx-auto w-full max-w-[720px] flex-1 px-safe pt-5 pb-8">{body}</main>
      {form && choices.length > 0 && (
        <div className="chrome sticky bottom-0 z-20 border-t border-line/70 pb-[max(12px,var(--safe-bottom))]">
          <div className="mx-auto w-full max-w-[720px] px-safe pt-3">
            {error && !error.field && (
              <p role="alert" className="mb-2 flex items-start gap-2 text-[13.5px] leading-snug text-err">
                <Icon name="alertCircle" size={16} className="mt-0.5 shrink-0" />
                {error.message}
              </p>
            )}
            <Button variant="primary" size="lg" icon="play" className="w-full" loading={submitting} onClick={() => void start()}>
              {submitting ? (progress !== null && progress < 1 ? `Uploading photos… ${Math.round(progress * 100)}%` : "Starting…") : "Start agent"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 px-1 text-[12px] font-semibold tracking-[0.08em] text-steel uppercase">{title}</h2>
      {hint && <p className="-mt-1 mb-2 px-1 text-[12.5px] text-steel">{hint}</p>}
      {children}
    </section>
  );
}

function AccountWarning({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="mt-2 flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/[0.07] px-3 py-2.5 text-[13px] leading-snug text-fg/90">
      <Icon name="alert" size={16} className="mt-px shrink-0 text-warn" />
      {children}
    </p>
  );
}

function FieldError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-2 flex items-center gap-1.5 px-1 text-[13px] text-err">
      <Icon name="alertCircle" size={15} className="shrink-0" />
      {children}
    </p>
  );
}

function RadioList({
  label,
  items,
}: {
  label: string;
  items: { key: string; selected: boolean; onSelect: () => void; content: ReactNode }[];
}) {
  return (
    <div role="radiogroup" aria-label={label} className="overflow-hidden rounded-2xl border border-line bg-card">
      {items.map((it, i) => (
        <button
          key={it.key}
          type="button"
          role="radio"
          aria-checked={it.selected}
          onClick={it.onSelect}
          className={cn("press-row flex min-h-[52px] w-full items-center gap-3 px-3.5 py-2 text-left", i > 0 && "border-t border-line/70")}
        >
          {it.content}
          <span
            className={cn(
              "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2",
              it.selected ? "border-accent bg-accent text-accent-fg" : "border-line-strong",
            )}
            aria-hidden
          >
            {it.selected && <Icon name="check" size={12} strokeWidth={3} />}
          </span>
        </button>
      ))}
    </div>
  );
}

function PathInput({ value, onChange, invalid, autoFocus }: { value: string; onChange: (v: string) => void; invalid: boolean; autoFocus: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <div className="mt-2">
      <label htmlFor="new-agent-path" className="sr-only">
        Folder path on your computer
      </label>
      <input
        id="new-agent-path"
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="/home/you/code/project"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode="url"
        aria-invalid={invalid}
        className={cn(
          "block h-12 w-full rounded-xl border bg-card px-3.5 font-mono text-[16px] text-fg outline-none placeholder:text-steel focus:border-accent/60",
          invalid ? "border-err/60" : "border-line-strong",
        )}
      />
      <p className="mt-1.5 px-1 text-[12.5px] text-steel">Full path of a folder on your computer.</p>
    </div>
  );
}

function Segmented<V extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: V;
  onChange: (v: V) => void;
  options: { value: V; label: string; hint: string }[];
}) {
  const current = options.find((o) => o.value === value);
  return (
    <div>
      <div role="radiogroup" aria-label={label} className="grid grid-flow-col auto-cols-fr gap-1 rounded-2xl border border-line bg-card p-1">
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(o.value)}
              className={cn(
                "press h-11 rounded-xl text-[14.5px] font-medium",
                selected ? "bg-raised text-fg shadow-[inset_0_1px_0_var(--edge-strong),0_1px_2px_rgba(0,0,0,0.4)]" : "text-muted",
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {current && <p className="mt-1.5 px-1 text-[12.5px] leading-snug text-steel">{current.hint}</p>}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  description,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn("press-row flex min-h-14 w-full items-center gap-3 rounded-2xl border border-line bg-card px-4 py-2.5 text-left", className)}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] text-fg">{label}</span>
        {description && <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">{description}</span>}
      </span>
      <span
        className={cn("relative inline-flex h-[30px] w-[50px] shrink-0 rounded-full", checked ? "bg-accent" : "bg-raised border border-line-strong")}
        aria-hidden
      >
        <span
          className="absolute top-[3px] h-6 w-6 rounded-full bg-white shadow transition-transform duration-150"
          style={{ transform: `translateX(${checked ? 23 : 3}px)` }}
        />
      </span>
    </button>
  );
}
