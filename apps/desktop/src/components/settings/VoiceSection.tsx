import { Check, Download, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useVoiceModelDownload } from "@/hooks/useVoiceModelDownload";
import { api } from "@/lib/api";
import { DICTATION_KEYS } from "@/lib/dictation";
import { formatBytes } from "@/lib/format";
import type { Settings, VoiceInputDevice, VoiceSettings, VoiceStatus } from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { saveSettingsPatch } from "./settingsErrors";
import { Kbd } from "@/components/ui/kbd";
import { SectionHeader, SettingGroup, SettingRow } from "./SettingRow";

const SYSTEM_DEFAULT = "__default__";

export function VoiceSection({ settings }: { settings: Settings }) {
  const voice = settings.voice;
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [devices, setDevices] = useState<VoiceInputDevice[] | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.voiceStatus());
    } catch (e) {
      toast.error("Couldn't read the dictation models", { description: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
    api
      .voiceListDevices()
      .then(setDevices)
      .catch((e) => {
        setDevices([]);
        setDeviceError(errorMessage(e));
      });
  }, [refresh]);

  const dl = useVoiceModelDownload(() => void refresh());

  const update = (patch: Partial<VoiceSettings>) =>
    saveSettingsPatch({ voice: { ...voice, ...patch } }, (message) =>
      toast.error("Couldn't save dictation settings", { description: message }),
    ).then((ok) => {
      if (ok) void refresh();
    });

  const models = status?.models ?? [];
  const current = models.find((m) => m.id === voice.model);
  const multilingual = current?.multilingual ?? false;

  const chooseModel = (id: string) => {
    const m = models.find((x) => x.id === id);
    // English-only models can't take another language.
    const language =
      m && !m.multilingual && voice.language !== "auto" && voice.language !== "en" ? "auto" : voice.language;
    void update({ model: id, language });
  };

  const remove = async (id: string) => {
    try {
      await api.voiceDeleteModel(id);
      await refresh();
    } catch (e) {
      toast.error("Couldn't delete the model", { description: errorMessage(e) });
    }
  };

  const deviceOptions = [
    { value: SYSTEM_DEFAULT, label: "System default" },
    ...(devices ?? []).map((d) => ({ value: d.name, label: d.isDefault ? `${d.name} (default)` : d.name })),
  ];
  // A saved device that is unplugged right now stays selectable so the choice isn't lost silently.
  if (voice.inputDevice && !deviceOptions.some((o) => o.value === voice.inputDevice)) {
    deviceOptions.push({ value: voice.inputDevice, label: `${voice.inputDevice} (not connected)` });
  }

  const languageOptions = [
    { value: "auto", label: multilingual ? "Detect automatically" : "English" },
    ...(multilingual ? (status?.languages ?? []).map(([code, name]) => ({ value: code, label: name })) : []),
  ];

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Voice dictation"
        description={
          <>
            Speak instead of typing: click the mic in a message box, or press{" "}
            <span className="inline-flex gap-0.5 align-middle">
              {DICTATION_KEYS.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
            . Speech is turned into text on this device; audio is never sent anywhere or saved.
          </>
        }
      />

      <SettingGroup title="Input">
        <SettingRow
          title="Microphone"
          description={deviceError ?? "Which input to record from."}
          htmlFor="voice-device"
        >
          <Select
            id="voice-device"
            aria-label="Microphone"
            className="h-8 w-[260px] max-w-full"
            value={voice.inputDevice ?? SYSTEM_DEFAULT}
            onValueChange={(v) => void update({ inputDevice: v === SYSTEM_DEFAULT ? null : v })}
            options={deviceOptions}
            disabled={devices === null}
          />
        </SettingRow>
        <SettingRow
          title="Language"
          description={
            multilingual
              ? "What you speak. Detection works well, but picking the language is more reliable."
              : "This model understands English only. Choose a multilingual model below for other languages."
          }
          htmlFor="voice-language"
        >
          <Select
            id="voice-language"
            aria-label="Dictation language"
            className="h-8 w-[200px]"
            value={multilingual ? voice.language : "auto"}
            onValueChange={(v) => void update({ language: v })}
            options={languageOptions}
            disabled={!multilingual}
          />
        </SettingRow>
        <SettingRow
          title="Send after dictating"
          description="Send the message as soon as the transcript is in. Off: the text waits in the box so you can edit it."
          htmlFor="voice-autosend"
        >
          <Switch
            id="voice-autosend"
            checked={voice.autoSend}
            onCheckedChange={(autoSend) => void update({ autoSend })}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        title="Speech model"
        description="Downloaded once from Hugging Face (whisper.cpp) and checked against a pinned checksum. Bigger is more accurate but slower."
      >
        {models.map((m) => {
          const selected = m.id === voice.model;
          const downloading = dl.active?.id === m.id;
          const pct =
            downloading && dl.active
              ? Math.min(100, Math.round((dl.active.done / Math.max(1, dl.active.total)) * 100))
              : 0;
          return (
            <SettingRow
              key={m.id}
              title={
                <span className="inline-flex items-center gap-2">
                  {m.label}
                  {m.isDefault && (
                    <span className="rounded bg-raised px-1.5 py-px text-[10.5px] font-normal text-steel">
                      Recommended
                    </span>
                  )}
                  {selected && m.installed && (
                    <span className="inline-flex items-center gap-0.5 text-[11px] font-normal text-ok">
                      <Check className="h-3 w-3" /> In use
                    </span>
                  )}
                </span>
              }
              description={`${m.description} · ${formatBytes(m.sizeBytes)}${m.multilingual ? " · many languages" : ""}`}
            >
              {downloading ? (
                <>
                  <div
                    className="h-1.5 w-28 overflow-hidden rounded-full bg-raised"
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="h-full rounded-full bg-accent transition-[width] duration-150"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="tabular w-9 text-right text-[11.5px] text-steel">{pct}%</span>
                  <Button variant="ghost" size="xs" onClick={dl.cancel} aria-label="Cancel download">
                    <X className="h-3 w-3" />
                    Cancel
                  </Button>
                </>
              ) : m.installed ? (
                <>
                  {!selected && (
                    <Button variant="outline" size="xs" onClick={() => chooseModel(m.id)}>
                      Use this
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void remove(m.id)}
                    aria-label={`Delete ${m.label}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={dl.active !== null}
                  onClick={() => {
                    void dl.start(m.id).then(() => {
                      // A fresh download becomes the model in use, unless one is already working.
                      if (!current?.installed) chooseModel(m.id);
                    });
                  }}
                >
                  <Download className="h-3 w-3" />
                  Download
                </Button>
              )}
            </SettingRow>
          );
        })}
      </SettingGroup>
    </div>
  );
}
