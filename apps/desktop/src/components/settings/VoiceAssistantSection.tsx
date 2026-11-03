import { ChevronRight, ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import type { Settings, VoiceAssistantSettings, VoiceAssistantUsage } from "@/lib/types";
import { formatCost, VA_DEFAULT_VOICES, VA_MODEL_DEFAULT } from "@/lib/voiceAssistant";
import { cn, errorMessage, isMac, modKey } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { acceleratorCaps, sameAccelerator } from "./acceleratorLabels";
import { HotkeyRecorder } from "./HotkeyRecorder";
import { saveSettingsPatch } from "./settingsErrors";
import { SectionHeader, SettingGroup, SettingRow } from "./SettingRow";

export const VA_PRIVACY_NOTICE =
  "Your voice and the agent information it reads are sent to OpenAI. Billed to your OpenAI API account per minute.";

const SESSION_LENGTHS = [5, 10, 15, 30, 60];
const SILENCE_TIMEOUTS = [30, 60, 120, 300];

const MISSING = "__none__";

export function VoiceAssistantSection({ settings }: { settings: Settings }) {
  const va = settings.voiceAssistant;
  const accounts = useApp((s) => s.accounts);
  const setView = useUi((s) => s.setView);
  const [voices, setVoices] = useState<string[]>(VA_DEFAULT_VOICES);
  const [usage, setUsage] = useState<VoiceAssistantUsage | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [model, setModel] = useState(va.model);
  const [advanced, setAdvanced] = useState(false);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const [hotkeySaving, setHotkeySaving] = useState(false);

  const keyAccounts = accounts.filter((a) => a.provider === "codex" && a.authKind === "api_key");

  useEffect(() => {
    api
      .vaVoices()
      .then(setVoices)
      .catch(() => {});
    api
      .vaUsage()
      .then(setUsage)
      .catch(() => {});
  }, []);

  const update = (patch: Partial<VoiceAssistantSettings>) =>
    saveSettingsPatch({ voiceAssistant: { ...va, ...patch } }, (message) =>
      toast.error("Couldn't save voice assistant settings", { description: message }),
    );

  const enable = async () => {
    const ok = await update({
      enabled: true,
      // A single OpenAI key account is the obvious choice.
      accountId: va.accountId ?? (keyAccounts.length === 1 ? keyAccounts[0]!.id : null),
    });
    if (ok) setConfirm(false);
  };

  const saveHotkey = async (hotkey: string) => {
    if (sameAccelerator(hotkey, settings.globalHotkey, isMac)) {
      setHotkeyError("That is already the global hotkey that brings Kvistcode forward. Pick a different one.");
      return;
    }
    setHotkeySaving(true);
    try {
      await useApp.getState().patchSettings({ voiceAssistant: { ...va, hotkey } });
      setHotkeyError(null);
    } catch (e) {
      // The backend refuses shortcuts it can't register (taken by another app, or not valid).
      setHotkeyError(errorMessage(e));
    } finally {
      setHotkeySaving(false);
    }
  };
  const hotkeyCaps = acceleratorCaps(va.hotkey, isMac);

  const accountOptions = [
    ...(va.accountId === null ? [{ value: MISSING, label: "Choose an OpenAI account…" }] : []),
    ...keyAccounts.map((a) => ({ value: a.id, label: a.name })),
  ];
  if (va.accountId && !keyAccounts.some((a) => a.id === va.accountId)) {
    accountOptions.push({ value: va.accountId, label: "Account removed" });
  }
  const hasAccount = !!va.accountId && keyAccounts.some((a) => a.id === va.accountId);
  const minutes = usage ? Math.round(usage.seconds / 60) : 0;

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Voice assistant"
        description={
          <>
            Talk to Kvistcode hands-free: ask what your agents are doing, start one, send a message or open a view.
            Start it from the title bar or with{" "}
            <span className="inline-flex gap-0.5 align-middle">
              <Kbd>{modKey}</Kbd>
              <Kbd>⇧</Kbd>
              <Kbd>A</Kbd>
            </span>
            . It can never approve permissions, delete or archive agents, commit, push or change settings.
          </>
        }
      />

      <div className="flex items-start gap-3 rounded-xl border border-warn/30 bg-warn/[0.07] px-4 py-3 text-[12.5px] leading-relaxed text-fg">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
        <p>
          <strong className="font-medium">{VA_PRIVACY_NOTICE}</strong> Unlike dictation, this is not processed on your
          device. Audio is not saved by Kvistcode.
        </p>
      </div>

      <SettingGroup>
        <SettingRow
          title="Enable the voice assistant"
          description="Nothing is sent to OpenAI until you press Talk."
          htmlFor="va-enabled"
        >
          <Switch
            id="va-enabled"
            checked={va.enabled}
            onCheckedChange={(on) => (on ? setConfirm(true) : void update({ enabled: false }))}
          />
        </SettingRow>
        <SettingRow
          title="Hotkey to talk from anywhere"
          description="Starts or stops the assistant even when Kvistcode is in the background. Record a shortcut, or leave it empty to turn it off."
        >
          <div className="flex max-w-full flex-col items-end gap-1.5">
            <div className="flex items-center gap-1.5">
              {hotkeyCaps.length > 0 ? (
                <span className="flex items-center gap-1">
                  {hotkeyCaps.map((c, i) => (
                    <Kbd key={`${c}${i}`}>{c}</Kbd>
                  ))}
                </span>
              ) : (
                <span className="text-[12px] text-steel">Off</span>
              )}
              {va.hotkey && (
                <button
                  type="button"
                  aria-label="Clear hotkey (turn off)"
                  title="Clear (turn off)"
                  disabled={hotkeySaving}
                  onClick={() => void saveHotkey("")}
                  className="flex h-5 w-5 items-center justify-center rounded text-steel transition-colors hover:bg-raised hover:text-fg"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
              <HotkeyRecorder disabled={hotkeySaving} onRecord={(acc) => void saveHotkey(acc)} />
            </div>
            {hotkeyError && (
              <p role="alert" className="max-w-[300px] text-right text-[11.5px] leading-snug text-err">
                {hotkeyError}
              </p>
            )}
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="OpenAI account" description="Sessions are billed to this account's API key.">
        {keyAccounts.length === 0 ? (
          <SettingRow
            title="Choose an OpenAI account"
            description="You have no OpenAI API key account yet. Add one in Accounts (Codex, API key). The key stays in your system keychain."
            stack
          >
            <Button size="sm" variant="primary" onClick={() => setView("accounts")}>
              Open Accounts
            </Button>
          </SettingRow>
        ) : (
          <SettingRow
            title={hasAccount ? "Account" : "Choose an OpenAI account"}
            description="Only OpenAI API key accounts can be used."
            htmlFor="va-account"
            className={cn(!hasAccount && "bg-accent/[0.06]")}
          >
            <Select
              id="va-account"
              aria-label="OpenAI account"
              className="h-8 w-[240px] max-w-full"
              value={va.accountId ?? MISSING}
              onValueChange={(v) => v !== MISSING && void update({ accountId: v })}
              options={accountOptions}
            />
          </SettingRow>
        )}
      </SettingGroup>

      {/* Session settings only matter once an account is chosen. */}
      <div
        inert={!hasAccount}
        className={cn("transition-opacity", !hasAccount && "pointer-events-none opacity-50")}
        aria-disabled={!hasAccount}
      >
        <SettingGroup title="Session">
          <SettingRow title="Voice" htmlFor="va-voice">
            <Select
              id="va-voice"
              aria-label="Assistant voice"
              className="h-8 w-[160px]"
              value={va.voice}
              onValueChange={(voice) => void update({ voice })}
              options={voices.map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) }))}
            />
          </SettingRow>
          <SettingRow
            title="I'm using headphones (allow interrupting)"
            description="Without headphones the microphone is muted while the assistant talks, so your speakers can't make it hear itself. With them, you can talk over it."
            htmlFor="va-headphones"
          >
            <Switch
              id="va-headphones"
              checked={va.headphones}
              onCheckedChange={(on) => void update({ headphones: on })}
            />
          </SettingRow>
          <SettingRow
            title="Run actions without asking"
            description="When you ask the voice assistant to start an agent, send a message or rename one, it does it at once instead of showing a card for you to press Confirm. Anyone or anything that reaches the assistant, including text an agent wrote, could then trigger those actions with no check from you. Agents you start this way still ask before changing files or running commands, and the assistant can never approve those requests. Off by default."
            htmlFor="va-autoconfirm"
          >
            <Switch
              id="va-autoconfirm"
              checked={va.autoConfirm}
              onCheckedChange={(on) => void update({ autoConfirm: on })}
            />
          </SettingRow>
          <SettingRow
            title="Maximum session length"
            description="The session ends by itself after this long, so a forgotten one can't keep billing."
            htmlFor="va-max"
          >
            <Select
              id="va-max"
              aria-label="Maximum session length"
              className="h-8 w-[130px]"
              value={String(va.maxSessionMins)}
              onValueChange={(v) => void update({ maxSessionMins: Number(v) })}
              options={SESSION_LENGTHS.map((m) => ({ value: String(m), label: `${m} min` }))}
            />
          </SettingRow>
          <SettingRow
            title="End after silence"
            description="Ends the session when nobody has spoken for this long."
            htmlFor="va-silence"
          >
            <Select
              id="va-silence"
              aria-label="End after silence"
              className="h-8 w-[130px]"
              value={String(va.silenceTimeoutSecs)}
              onValueChange={(v) => void update({ silenceTimeoutSecs: Number(v) })}
              options={SILENCE_TIMEOUTS.map((s) => ({
                value: String(s),
                label: s < 120 ? `${s} sec` : `${s / 60} min`,
              }))}
            />
          </SettingRow>
          <div>
            <button
              type="button"
              aria-expanded={advanced}
              onClick={() => setAdvanced((v) => !v)}
              className="flex w-full items-center gap-1.5 px-4 py-3 text-left text-[13px] font-medium text-muted transition-colors hover:text-fg"
            >
              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", advanced && "rotate-90")} />
              Advanced
            </button>
            {advanced && (
              <div className="border-t border-line">
                <SettingRow
                  title="Model"
                  description={`Realtime model id. Default: ${VA_MODEL_DEFAULT}.`}
                  htmlFor="va-model"
                >
                  <Input
                    id="va-model"
                    className="h-8 w-[200px]"
                    value={model}
                    spellCheck={false}
                    onChange={(e) => setModel(e.target.value)}
                    onBlur={() => {
                      const next = model.trim() || VA_MODEL_DEFAULT;
                      setModel(next);
                      if (next !== va.model) void update({ model: next });
                    }}
                  />
                </SettingRow>
              </div>
            )}
          </div>
        </SettingGroup>
      </div>

      <SettingGroup title="This month">
        <SettingRow
          title={`${minutes} min used`}
          description="The cost is an estimate from the token usage OpenAI reports, at published gpt-realtime audio rates. Your OpenAI usage page has the real figure."
        >
          <span className="tabular text-[13px] text-fg">
            ~{formatCost(usage?.costUsd ?? 0)} <span className="text-steel">estimate</span>
          </span>
        </SettingRow>
      </SettingGroup>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Turn on the voice assistant?"
        description={VA_PRIVACY_NOTICE}
        confirmLabel="Turn on"
        onConfirm={async () => {
          try {
            await enable();
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }}
      >
        <p className="text-[12.5px] text-muted">
          You'll also need to pick an OpenAI API key account below. You can turn this off any time.
        </p>
      </ConfirmDialog>
    </div>
  );
}
