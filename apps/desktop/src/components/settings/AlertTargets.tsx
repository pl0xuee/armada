import { Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge, Spinner } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import {
  ALERT_EVENTS,
  ALERT_KINDS,
  MAX_ALERT_TARGETS,
  guessAlertKind,
  kindLabel,
  maskAlertUrl,
  newAlertTarget,
  validateAlertUrl,
} from "@/lib/alertTargets";
import type { AlertEvents, AlertKind, AlertTarget } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { FieldError } from "./FieldError";
import { saveSettingsPatch } from "./settingsErrors";
import { SettingGroup, SettingRow } from "./SettingRow";

type TestState = { state: "sending" } | { state: "sent" } | { state: "error"; message: string };

/** Slack, Discord and webhook targets for alerts, next to the desktop notification and ntfy. */
export function AlertTargets({ targets }: { targets: AlertTarget[] }) {
  const [tests, setTests] = useState<Record<string, TestState | undefined>>({});
  const save = (next: AlertTarget[]) =>
    saveSettingsPatch({ alertTargets: next }, (message) =>
      toast.error("Couldn't save alert targets", { description: message }),
    );
  const update = (id: string, patch: Partial<AlertTarget>) =>
    save(targets.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const test = async (key: string, run: () => Promise<void>) => {
    setTests((t) => ({ ...t, [key]: { state: "sending" } }));
    try {
      await run();
      setTests((t) => ({ ...t, [key]: { state: "sent" } }));
    } catch (e) {
      setTests((t) => ({ ...t, [key]: { state: "error", message: errorMessage(e) } }));
    }
  };

  return (
    <SettingGroup
      title="Slack, Discord and webhooks"
      description="Also post alerts to a chat channel or your own endpoint. Each target chooses its events."
    >
      {targets.map((t) => (
        <TargetRow
          key={t.id}
          target={t}
          test={tests[t.id]}
          onToggle={(enabled) => void update(t.id, { enabled })}
          onEvents={(events) => void update(t.id, { events })}
          onRemove={() => void save(targets.filter((x) => x.id !== t.id))}
          onTest={() => void test(t.id, () => api.testAlertTarget(t.kind, { targetId: t.id }))}
        />
      ))}
      {targets.length < MAX_ALERT_TARGETS ? (
        <AddTarget
          test={tests["new"]}
          onTest={(kind, url) => void test("new", () => api.testAlertTarget(kind, { url }))}
          onAdd={async (target) => {
            const ok = await save([...targets, target]);
            if (ok) setTests((t) => ({ ...t, new: undefined }));
            return ok;
          }}
        />
      ) : (
        <p className="px-4 py-3 text-[12px] text-steel">That's the most targets Kvistcode keeps ({MAX_ALERT_TARGETS}).</p>
      )}
      <div className="px-4 py-3 text-[12px] leading-relaxed text-muted">
        <FieldError field="alerts" />
        Messages carry only the agent&rsquo;s name, its project, what happened and a one-line summary with secrets
        scrubbed, never file contents or your prompts. A burst is combined into one message, and a target gets at most
        40 messages an hour. Webhook URLs are secrets: they are kept in your OS keychain and shown masked here. Quiet
        hours still apply.
      </div>
    </SettingGroup>
  );
}

function TestResult({ test }: { test?: TestState }) {
  if (!test || test.state === "sending") return null;
  return test.state === "sent" ? (
    <p role="status" className="text-[11.5px] text-ok">
      Sent. Check the channel.
    </p>
  ) : (
    <p role="alert" className="break-words text-[11.5px] text-err">
      {test.message}
    </p>
  );
}

function TargetRow({
  target,
  test,
  onToggle,
  onEvents,
  onRemove,
  onTest,
}: {
  target: AlertTarget;
  test?: TestState;
  onToggle: (enabled: boolean) => void;
  onEvents: (events: AlertEvents) => void;
  onRemove: () => void;
  onTest: () => void;
}) {
  const label = target.name || `${kindLabel(target.kind)} webhook`;
  return (
    <div className={cn("space-y-2.5 px-4 py-3.5", !target.enabled && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-[200px]">
          <p className="flex items-center gap-2 text-[13px] font-medium">
            <span className="truncate">{label}</span>
            {target.name && <Badge tone="accent">{kindLabel(target.kind)}</Badge>}
          </p>
          <p className="truncate font-mono text-[11.5px] text-steel" title="Hidden: the full URL is a secret">
            {maskAlertUrl(target.url)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={test?.state === "sending"}
            onClick={onTest}
            title="Post a test message to this target"
          >
            {test?.state === "sending" ? <Spinner className="h-3.5 w-3.5" /> : <Send />}
            Send test
          </Button>
          <Switch checked={target.enabled} onCheckedChange={onToggle} aria-label={`${label} enabled`} />
          <Button size="icon-sm" variant="ghost" aria-label={`Remove ${label}`} onClick={onRemove}>
            <Trash2 />
          </Button>
        </div>
      </div>
      <EventToggles events={target.events} idBase={target.id} onChange={onEvents} />
      <TestResult test={test} />
    </div>
  );
}

function EventToggles({
  events,
  idBase,
  onChange,
}: {
  events: AlertEvents;
  idBase: string;
  onChange: (events: AlertEvents) => void;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5" role="group" aria-label="Events">
      {ALERT_EVENTS.map((e) => (
        <label
          key={e.key}
          htmlFor={`${idBase}-${e.key}`}
          title={e.hint}
          className="flex cursor-pointer items-center gap-2 text-[12.5px] text-muted"
        >
          <Checkbox
            id={`${idBase}-${e.key}`}
            checked={events[e.key]}
            onCheckedChange={(v) => onChange({ ...events, [e.key]: v })}
          />
          {e.label}
        </label>
      ))}
    </div>
  );
}

function AddTarget({
  test,
  onTest,
  onAdd,
}: {
  test?: TestState;
  onTest: (kind: AlertKind, url: string) => void;
  onAdd: (target: AlertTarget) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<AlertKind>("slack");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const spec = ALERT_KINDS.find((k) => k.value === kind)!;
  const problem = url.trim() ? validateAlertUrl(kind, url) : null;
  const guess = guessAlertKind(url);
  const wrongKind = guess && guess !== kind ? kindLabel(guess) : null;
  const ready = url.trim() !== "" && !problem;

  const add = async () => {
    setTouched(true);
    if (!ready) return;
    const ok = await onAdd(newAlertTarget(kind, url, name));
    if (ok) {
      setUrl("");
      setName("");
      setTouched(false);
    }
  };

  return (
    <SettingRow stack title="Add a target" description={spec.hint}>
      <div className="w-full space-y-2.5">
        <Segmented
          aria-label="Kind of target"
          value={kind}
          onChange={(v) => setKind(v)}
          className="w-full max-w-[360px]"
          options={ALERT_KINDS.map((k) => ({ value: k.value, label: k.label }))}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Webhook URL"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={url}
            placeholder={spec.placeholder}
            aria-invalid={(touched || url.trim() !== "") && !!problem ? true : undefined}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void add()}
            className={cn(
              "min-w-0 flex-1 basis-[260px] font-mono text-[12.5px]",
              problem && "border-err/60 focus:border-err/60 focus:ring-err/15",
            )}
          />
          <Input
            aria-label="Name (optional)"
            value={name}
            maxLength={60}
            placeholder="Name (optional)"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void add()}
            className="w-[170px]"
          />
        </div>
        {problem && (
          <p role="alert" className="text-[11.5px] text-err">
            {problem}
          </p>
        )}
        {!problem && wrongKind && (
          <p className="text-[11.5px] text-warn">This looks like a {wrongKind} URL. Pick {wrongKind} above.</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" disabled={!ready} onClick={() => void add()}>
            Add target
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!ready || test?.state === "sending"}
            onClick={() => onTest(kind, url)}
            title="Post a test message before saving"
          >
            {test?.state === "sending" ? <Spinner className="h-3.5 w-3.5" /> : <Send />}
            Send test
          </Button>
        </div>
        <TestResult test={test} />
      </div>
    </SettingRow>
  );
}
