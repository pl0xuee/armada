import { Bot, Sparkles, Workflow } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { readWorkChoice } from "@/lib/modelGuide";
import {
  askOnNewProject,
  EFFORTS,
  HELPER_EFFORTS,
  HELPER_MODELS,
  MAIN_MODELS,
  otherProviders,
  othersFrom,
  RECOMMENDED_SETUP,
  sameClaude,
  sameSetup,
  sameValues,
  setAskOnNewProject,
  setupFrom,
  type ModelSetup,
  type OtherProvider,
} from "@/lib/modelSetup";
import type { ConfigOption } from "@/lib/types";
import { useApp } from "@/store/app";
import { saveModelSetup } from "./settings/modelSetupActions";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "./ui/dialog";
import { Spinner } from "./ui/misc";
import { Segmented } from "./ui/segmented";
import { Select } from "./ui/select";

/** Keeps a value the lists don't know (an older or newer Claude Code alias) selectable. */
const withValue = (list: { value: string; label: string }[], v: string) =>
  list.some((o) => o.value === v) ? list : [...list, { value: v, label: v }];

/**
 * "Choose your models": what new agents start with, per provider. Claude: the main agent's model and
 * effort and the helper agents' model and effort, with the recommended setup one click away. Codex,
 * Grok and custom agents (Gemini CLI, ...): the model and effort their agents offer. Shown when a
 * project is made (unless turned off) and from Settings.
 */
export function ModelSetupDialog({
  open,
  onOpenChange,
  newProject = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opened because a project was just made: offers "Ask me for each new project". */
  newProject?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[560px]"
        title="Choose your models"
        description="What new agents start with. You can change this any time in Settings, or per agent next to the prompt."
      >
        {open && <Body newProject={newProject} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({ newProject, onClose }: { newProject: boolean; onClose: () => void }) {
  const saver = useApp((s) => s.settings?.tokenSaver);
  const agentsMap = useApp((s) => s.agents);
  const providers = useApp((s) => s.providers);
  const customAgents = useApp((s) => s.settings?.customAgents);
  // Read once: the lists don't shift while the user picks.
  const others = useMemo(
    () => otherProviders(Object.values(agentsMap), providers, customAgents ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [tab, setTab] = useState("claude");
  const [current, setCurrent] = useState<ModelSetup | null>(null);
  const [form, setForm] = useState<ModelSetup | null>(null);
  const [ask, setAsk] = useState(askOnNewProject);
  const [busy, setBusy] = useState(false);
  const askId = useId();

  useEffect(() => {
    let live = true;
    void api
      .configDefaults()
      .catch(() => ({}) as Record<string, Record<string, string>>)
      .then((d) => {
        if (!live) return;
        const now = { ...setupFrom(readWorkChoice(), d.claude, saver), others: othersFrom(d, others) };
        setCurrent(now);
        setForm((f) => f ?? now);
      });
    return () => {
      live = false;
    };
    // Read once when the dialog opens; edits after that are the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!form || !current) {
    return (
      <DialogBody className="flex h-48 items-center justify-center">
        <Spinner />
      </DialogBody>
    );
  }

  const set = (patch: Partial<ModelSetup>) => setForm({ ...form, ...patch });
  const recommended = sameClaude(form, RECOMMENDED_SETUP);
  const changed = !sameSetup(form, current);

  const save = async () => {
    if (newProject) setAskOnNewProject(ask);
    if (!changed) return onClose();
    setBusy(true);
    try {
      const changedOthers = others.filter((p) => !sameValues(form.others[p.key], current.others[p.key]));
      if (
        await saveModelSetup(
          form,
          current,
          changedOthers.map((p) => p.name),
        )
      )
        onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogBody className="space-y-4">
        {others.length > 0 && (
          <Segmented
            aria-label="Provider"
            size="sm"
            className="flex w-full [&>*]:flex-1"
            value={tab}
            onChange={setTab}
            options={[{ value: "claude", label: "Claude" }, ...others.map((p) => ({ value: p.key, label: p.name }))]}
          />
        )}
        {tab === "claude" ? (
          <>
            <div className="flex items-start gap-3 rounded-xl border border-accent/25 bg-accent/[0.06] px-3.5 py-3">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <p className="text-body font-medium text-fg">Recommended setup</p>
                <p className="mt-0.5 text-caption leading-snug text-muted">
                  From Anthropic's model guide: Opus at medium effort for the main agent, and helper agents on Sonnet.
                </p>
              </div>
              <Button
                size="sm"
                variant={recommended ? "secondary" : "primary"}
                disabled={recommended}
                onClick={() => setForm({ ...RECOMMENDED_SETUP })}
              >
                {recommended ? "Selected" : "Use recommended"}
              </Button>
            </div>

            <Section
              icon={<Bot className="h-4 w-4" />}
              title="Main agent"
              note={MAIN_MODELS.find((m) => m.value === form.model)?.hint ?? "The agent you talk to."}
            >
              <Field label="Model">
                <Select
                  aria-label="Main agent model"
                  value={form.model}
                  onValueChange={(v) => set({ model: v })}
                  options={withValue(MAIN_MODELS, form.model)}
                />
              </Field>
              <Field label="Effort">
                <Select
                  aria-label="Main agent effort"
                  value={form.effort}
                  onValueChange={(v) => set({ effort: v })}
                  options={withValue(EFFORTS, form.effort)}
                />
              </Field>
            </Section>

            <Section
              icon={<Workflow className="h-4 w-4" />}
              title="Helper agents"
              note="Claude splits work into helpers (sub-agents). A smaller model and lower effort here save a lot of usage, and they're held to this even when an agent asks for something else."
            >
              <Field label="Model">
                <Select
                  aria-label="Helper agent model"
                  value={form.helperModel ?? "same"}
                  onValueChange={(v) => set({ helperModel: v === "same" ? null : v })}
                  options={HELPER_MODELS}
                />
              </Field>
              <Field label="Effort">
                <Select
                  aria-label="Helper agent effort"
                  value={form.helperEffort ?? "auto"}
                  onValueChange={(v) => set({ helperEffort: v === "auto" ? null : v })}
                  options={HELPER_EFFORTS}
                />
              </Field>
            </Section>
          </>
        ) : (
          <OtherTab
            provider={others.find((p) => p.key === tab)!}
            values={form.others[tab] ?? {}}
            onChange={(values) => setForm({ ...form, others: { ...form.others, [tab]: values } })}
          />
        )}

        <p className="text-caption text-steel">Agents that are already running keep what they have.</p>

        {newProject && (
          <div className="flex items-center gap-2.5">
            <Checkbox id={askId} checked={ask} onCheckedChange={setAsk} />
            <label htmlFor={askId} className="cursor-pointer text-small text-muted">
              Ask me each time I start a new project
            </label>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            if (newProject) setAskOnNewProject(ask);
            onClose();
          }}
        >
          {newProject ? "Not now" : "Cancel"}
        </Button>
        <Button type="button" variant="primary" disabled={busy} onClick={() => void save()}>
          {busy && <Spinner className="text-current" />}
          {changed ? "Save" : "Keep these"}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Stands for "nothing remembered" in a Select (which can't hold ""). */
const DEFAULT = "\u0000default";

/** A provider's own default, then the choices its agents offer. */
const choicesOf = (provider: string, o: ConfigOption) => [
  { value: DEFAULT, label: `${provider} default` },
  ...o.options.map((c) => ({ value: c.value, label: c.name || c.value })),
];

function OtherTab({
  provider,
  values,
  onChange,
}: {
  provider: OtherProvider;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}) {
  const { name, seen, model, effort } = provider;
  const pick = (o: ConfigOption, label: string) => {
    const v = values[o.id] || DEFAULT;
    return (
      <Field label={label}>
        <Select
          aria-label={`${name} ${label.toLowerCase()}`}
          value={v}
          onValueChange={(next) => onChange({ ...values, [o.id]: next === DEFAULT ? "" : next })}
          options={withValue(choicesOf(name, o), v)}
        />
      </Field>
    );
  };
  return (
    <>
      <Section
        icon={<Bot className="h-4 w-4" />}
        title="Main agent"
        note={
          model || effort
            ? `${name} agents start with this. "${name} default" leaves it to ${name}.`
            : seen
              ? `${name} doesn't offer a model or effort choice, so its agents use ${name}'s own settings.`
              : `Start one ${name} agent first; Kvistcode learns which models ${name} offers from it.`
        }
      >
        {model ? pick(model, "Model") : <Unknown label="Model" />}
        {effort ? pick(effort, "Effort") : <Unknown label="Effort" />}
      </Section>
      <section className="rounded-xl border border-line bg-card/40 px-3.5 py-3">
        <div className="flex items-center gap-2 text-body font-medium text-fg">
          <span className="text-steel">
            <Workflow className="h-4 w-4" />
          </span>
          Helper agents
        </div>
        <p className="mt-1.5 text-caption leading-snug text-steel">
          {name} doesn't let Kvistcode choose its helpers' model, so they follow {name}'s own settings.
        </p>
      </section>
    </>
  );
}

function Unknown({ label }: { label: string }) {
  return (
    <Field label={label}>
      <div className="flex h-9 items-center rounded-lg border border-dashed border-line px-3 text-small text-steel">
        Not known yet
      </div>
    </Field>
  );
}

function Section({
  icon,
  title,
  note,
  children,
}: {
  icon: ReactNode;
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-card/40 px-3.5 py-3">
      <div className="flex items-center gap-2 text-body font-medium text-fg">
        <span className="text-steel">{icon}</span>
        {title}
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-3 max-sm:grid-cols-1">{children}</div>
      <p className="mt-2 text-caption leading-snug text-steel">{note}</p>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <span aria-hidden className="mb-1 block text-micro font-medium uppercase tracking-wide text-steel">
        {label}
      </span>
      {children}
    </div>
  );
}
