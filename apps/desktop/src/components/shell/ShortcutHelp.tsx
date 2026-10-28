import { create } from "zustand";
import { APPROVAL_KEYS } from "@/lib/approvalKeys";
import { modKey } from "@/lib/utils";
import { Dialog, DialogBody, DialogContent } from "../ui/dialog";
import { Kbd } from "../ui/kbd";

const useHelp = create<{ open: boolean; setOpen: (o: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function openShortcutHelp() {
  useHelp.getState().setOpen(true);
}

export function toggleShortcutHelp() {
  const s = useHelp.getState();
  s.setOpen(!s.open);
}

type Row = { keys: string[]; label: string };

const SECTIONS: { title: string; rows: Row[] }[] = [
  {
    title: "Anywhere",
    rows: [
      { keys: [modKey, "K"], label: "Command palette (type > to start an agent)" },
      { keys: [modKey, "N"], label: "New agent" },
      { keys: [modKey, "J"], label: "Needs you (press again for the next one)" },
      { keys: [modKey, "I"], label: "Inbox" },
      { keys: [modKey, "⇧", "M"], label: "Mission Control" },
      { keys: [modKey, "B"], label: "Show or hide the agent list" },
      { keys: [modKey, "1–9"], label: "Jump to an agent" },
      { keys: [modKey, ","], label: "Settings" },
      { keys: [modKey, "/"], label: "This cheat sheet (also ?)" },
      { keys: ["Esc"], label: "Close the open dialog or menu" },
    ],
  },
  {
    title: "Approvals (agent view, Needs you, Inbox)",
    rows: [...APPROVAL_KEYS, { keys: ["⏎"], label: "Allow once, when focus is on the approval card" }],
  },
  {
    title: "Agent view",
    rows: [
      { keys: ["⏎"], label: "Send (queues if the agent is busy)" },
      { keys: ["⇧", "⏎"], label: "New line" },
      { keys: ["/"], label: "Slash commands (at the start of the message)" },
      { keys: ["@"], label: "Mention a file" },
      { keys: ["Esc"], label: "Stop this turn (press twice from an empty composer)" },
      { keys: ["F2"], label: "Rename the focused agent in the list" },
      { keys: ["/"], label: "Filter the agent list (when nothing is focused)" },
    ],
  },
  {
    title: "Needs you",
    rows: [
      { keys: ["J"], label: "Next" },
      { keys: ["K"], label: "Previous" },
      { keys: ["⏎"], label: "Open the agent" },
      { keys: ["E"], label: "Done (mark it handled)" },
      { keys: ["⇧", "E"], label: "Archive" },
    ],
  },
  {
    title: "Inbox",
    rows: [
      { keys: ["J"], label: "Next request" },
      { keys: ["K"], label: "Previous request" },
      { keys: ["⏎"], label: "Open the agent" },
    ],
  },
  {
    title: "Review",
    rows: [
      { keys: ["↑", "↓"], label: "Move between diff lines (j / k too)" },
      { keys: ["⏎"], label: "Comment on the line (or c)" },
      { keys: [modKey, "⏎"], label: "Save the comment" },
    ],
  },
];

/** "?" / Ctrl+/ overlay listing every keyboard shortcut. */
export function ShortcutHelp() {
  const open = useHelp((s) => s.open);
  const setOpen = useHelp((s) => s.setOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        title="Keyboard shortcuts"
        description="Armada is fully usable from the keyboard."
        className="w-[min(760px,calc(100vw-16px))]"
        sheet
      >
        <DialogBody className="grid gap-x-8 gap-y-5 pb-5 sm:grid-cols-2">
          {SECTIONS.map((sec) => (
            <section key={sec.title} aria-labelledby={`sc-${sec.title}`}>
              <h3
                id={`sc-${sec.title}`}
                className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-steel"
              >
                {sec.title}
              </h3>
              <dl className="space-y-1.5">
                {sec.rows.map((r) => (
                  <div key={r.label} className="flex items-center justify-between gap-3 text-[12.5px]">
                    <dt className="text-muted">{r.label}</dt>
                    <dd className="flex shrink-0 gap-0.5">
                      {r.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
