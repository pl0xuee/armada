import { Keyboard } from "lucide-react";
import { useEffect, useState } from "react";
import { isMac } from "@/lib/utils";
import { Button } from "../ui/button";

const CODE_KEYS: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

/** A keydown → Tauri accelerator ("CmdOrCtrl+Shift+Space"), or null while only modifiers are held. */
export function acceleratorFor(e: KeyboardEvent): string | null {
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1\d|2[0-4])$/.test(e.code)) key = e.code;
  else key = CODE_KEYS[e.code] ?? null;
  if (!key) return null;
  const mods: string[] = [];
  // ⌘ on macOS / Ctrl elsewhere map to the portable CmdOrCtrl.
  if (isMac ? e.metaKey : e.ctrlKey) mods.push("CmdOrCtrl");
  if (isMac && e.ctrlKey) mods.push("Ctrl");
  if (!isMac && e.metaKey) mods.push("Super");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  // A global shortcut without a modifier would swallow normal typing (F-keys excepted).
  if (mods.length === 0 && !/^F\d+$/.test(key)) return null;
  return [...mods, key].join("+");
}

/** "Record" button: press the shortcut to capture it as a Tauri accelerator. Esc cancels. */
export function HotkeyRecorder({
  onRecord,
  disabled,
}: {
  onRecord: (accelerator: string) => void;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        setRecording(false);
        return;
      }
      const acc = acceleratorFor(e);
      if (acc) {
        setRecording(false);
        onRecord(acc);
      } else if (!["Control", "Meta", "Alt", "Shift"].includes(e.key)) {
        setHint("Add a modifier (Ctrl/⌘, Alt or Shift)");
      }
    };
    // Capture phase so app shortcuts don't fire while recording.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onRecord]);

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant={recording ? "primary" : "secondary"}
        disabled={disabled}
        aria-pressed={recording}
        onClick={() => {
          setHint(null);
          setRecording((r) => !r);
        }}
        onBlur={() => setRecording(false)}
      >
        <Keyboard />
        {recording ? "Press keys…" : "Record"}
      </Button>
      <span role="status" className="text-[11.5px] text-steel">
        {recording ? (hint ?? "Press the shortcut, or Esc to cancel") : ""}
      </span>
    </div>
  );
}
