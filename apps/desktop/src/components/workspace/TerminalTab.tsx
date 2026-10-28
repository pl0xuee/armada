import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { CornerDownLeft, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { insertIntoDraft } from "@/components/agent/drafts";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { Agent } from "@/lib/types";
import { cn, errorMessage, isMac } from "@/lib/utils";
import { bufferTail, fenced, themeFromCss, XTERM_FONT, XTERM_LINK_HANDLER } from "@/lib/xterm-theme";
import { useUi } from "@/store/ui";
import {
  agentWs,
  closeTerminal,
  MAX_TERMINALS_PER_AGENT,
  openTerminal,
  setTerminalView,
  terminalTranscript,
  terminalView,
  useWorkspace,
  type WsTerm,
} from "@/store/workspace";

const SEND_LINES = 200;

export function TerminalTab({ agent }: { agent: Agent }) {
  const ws = useWorkspace((s) => agentWs(s, agent.id));
  const setActive = useWorkspace((s) => s.setActive);
  const active = ws.terms.find((t) => t.id === ws.active) ?? ws.terms[0] ?? null;

  const newTerminal = () =>
    openTerminal(agent.id).catch((e: unknown) =>
      toast.error("Couldn't open a terminal", { description: errorMessage(e) }),
    );

  // First time the panel is shown for this agent: start a shell (not again after closing them all).
  useEffect(() => {
    if (ws.terms.length > 0 || ws.autoStarted) return;
    void newTerminal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  const send = () => {
    if (!active) return;
    const snap = terminalView(active.id)?.snapshot(SEND_LINES);
    if (!snap || !snap.text.trim()) {
      toast("Nothing to send yet");
      return;
    }
    insertIntoDraft(agent.id, fenced(snap.text));
    useUi.getState().focusComposer();
    toast.success(snap.selection ? "Selection added to the message" : `Last ${SEND_LINES} lines added to the message`);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line px-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          <div
            role="tablist"
            aria-label="Terminals"
            onKeyDown={onTabListKeyDown}
            className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
          >
            {ws.terms.map((t) => (
              <TermChip
                key={t.id}
                term={t}
                selected={t.id === active?.id}
                onSelect={() => setActive(agent.id, t.id)}
                onClose={() => closeTerminal(agent.id, t.id)}
              />
            ))}
          </div>
          <Tooltip content="New terminal">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="New terminal"
              disabled={ws.terms.length >= MAX_TERMINALS_PER_AGENT}
              onClick={() => void newTerminal()}
            >
              <Plus />
            </Button>
          </Tooltip>
        </div>
        <Tooltip content="Send the selection (or the last 200 lines) to the agent">
          <Button size="xs" variant="ghost" disabled={!active} onClick={send}>
            <CornerDownLeft className="!h-3 !w-3" /> Send to agent
          </Button>
        </Tooltip>
      </div>
      {active ? (
        <XtermView key={active.id} term={active} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-[12.5px] text-steel">
          {ws.autoStarted ? "No terminals. Press + to open one." : "Starting a shell…"}
        </div>
      )}
    </div>
  );
}

/** Arrow keys / Home / End move between tabs (selection follows focus). */
function onTabListKeyDown(e: React.KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  const cur = tabs.findIndex((t) => t === document.activeElement);
  if (cur < 0) return;
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? tabs.length - 1
        : (cur + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  e.preventDefault();
  tabs[next].focus();
  tabs[next].click();
}

function TermChip({
  term,
  selected,
  onSelect,
  onClose,
}: {
  term: WsTerm;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const running = term.exit === undefined;
  return (
    <div
      className={cn(
        "group/chip flex h-6 shrink-0 items-center rounded-md border text-[12px] transition-colors",
        selected ? "border-line-strong bg-raised text-fg" : "border-transparent text-muted hover:bg-raised/60",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        onClick={onSelect}
        className="flex max-w-[160px] items-center gap-1.5 truncate rounded-md pl-2 pr-1 outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <span
          aria-hidden
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            running ? "bg-ok" : term.exit === 0 ? "bg-steel" : "bg-err",
          )}
        />
        <span className="truncate">{term.title}</span>
      </button>
      <button
        type="button"
        aria-label={`Close ${term.title}`}
        onClick={onClose}
        className="mr-0.5 flex h-4 w-4 items-center justify-center rounded text-steel hover:bg-line hover:text-fg"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function XtermView({ term: session }: { term: WsTerm }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const exitedRef = useRef(session.exit !== undefined);
  exitedRef.current = session.exit !== undefined;

  useEffect(() => {
    if (!host) return;
    const id = session.id;
    const term = new Terminal({
      linkHandler: XTERM_LINK_HANDLER,
      fontFamily: XTERM_FONT,
      fontSize: 12.5,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: "bar",
      allowProposedApi: false,
      scrollback: 5000,
      theme: themeFromCss(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const doFit = () => {
      try {
        fit.fit();
        void api.terminalResize(id, term.cols, term.rows).catch(() => {});
      } catch {
        /* not measurable yet */
      }
    };
    const raf = requestAnimationFrame(() => {
      doFit();
      term.focus();
    });
    const ro = new ResizeObserver(() => doFit());
    ro.observe(host);

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const k = e.key.toLowerCase();
      // Let the app's panel toggle (Ctrl/Cmd+`) through instead of sending NUL to the shell.
      if (e.key === "`" && (isMac ? e.metaKey : e.ctrlKey)) return false;
      const copyCombo = isMac ? e.metaKey && k === "c" : e.ctrlKey && k === "c" && (e.shiftKey || term.hasSelection());
      const pasteCombo = isMac ? e.metaKey && k === "v" : e.ctrlKey && e.shiftKey && k === "v";
      if (copyCombo) {
        if (term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
          term.clearSelection();
        }
        e.preventDefault();
        return false;
      }
      if (pasteCombo) {
        e.preventDefault();
        void navigator.clipboard
          .readText()
          .then((t) => {
            if (t && !exitedRef.current) term.paste(t);
          })
          .catch(() => toast.error("Couldn't read the clipboard"));
        return false;
      }
      return true;
    });

    const dataSub = term.onData((d) => {
      if (exitedRef.current) return;
      void api
        .terminalWrite(id, d)
        .catch((e: unknown) =>
          toast.error("Couldn't send input to the terminal", { id: `term-write-${id}`, description: errorMessage(e) }),
        );
    });

    term.write(terminalTranscript(id));
    setTerminalView(id, {
      write: (d) => term.write(d),
      snapshot: (lines) =>
        term.hasSelection()
          ? { text: term.getSelection(), selection: true }
          : { text: bufferTail(term, lines), selection: false },
    });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      dataSub.dispose();
      setTerminalView(id, undefined);
      term.dispose();
    };
  }, [session.id, host]);

  return <div ref={setHost} className="xterm-host min-h-0 flex-1 bg-code px-2 py-1" aria-label="Terminal" />;
}
