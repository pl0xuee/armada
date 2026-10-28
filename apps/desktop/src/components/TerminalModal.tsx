import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { CircleCheck, CircleX, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { attachTerminal } from "@/lib/terminal-bus";
import { themeFromCss, XTERM_FONT } from "@/lib/xterm-theme";
import { errorMessage, isMac } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { useApp } from "@/store/app";
import { useUi, type TerminalSession } from "@/store/ui";

type RunState = { kind: "running" } | { kind: "exited"; code: number | null };

/**
 * Everything a terminal has printed, so a remounted view (StrictMode, reopen)
 * can replay output the bus already handed to a previous instance.
 */
const transcripts = new Map<string, { data: string; exit?: number | null }>();

/** Per-terminal transcript cap (UTF-16 units ≈ bytes for terminal text); the oldest output is dropped. */
const TRANSCRIPT_MAX = 2_000_000;
const TRANSCRIPT_KEEP = 1_500_000;

function appendTranscript(tr: { data: string }, d: string) {
  tr.data += d;
  if (tr.data.length > TRANSCRIPT_MAX) {
    const cut = tr.data.length - TRANSCRIPT_KEEP;
    // Resume at a line start so a replay doesn't begin mid escape sequence.
    const nl = tr.data.indexOf("\n", cut);
    tr.data = tr.data.slice(nl >= 0 ? nl + 1 : cut);
  }
}

/** Global modal hosting a PTY (provider login / CLI install). */
export function TerminalModal() {
  const session = useUi((s) => s.terminal);
  const setTerminal = useUi((s) => s.setTerminal);
  // Keep the last session around while the close animation plays.
  const [shown, setShown] = useState<TerminalSession | null>(session);
  useEffect(() => {
    if (session) setShown(session);
  }, [session]);

  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        if (open || !session) return;
        // Esc / click-outside: stop the process if it's still running.
        const t = transcripts.get(session.terminalId);
        if (!t || t.exit === undefined) void api.terminalKill(session.terminalId).catch(() => {});
        transcripts.delete(session.terminalId);
        setTerminal(null);
      }}
    >
      {shown && <TerminalDialogBody key={shown.terminalId} session={shown} onClose={() => setTerminal(null)} />}
    </Dialog>
  );
}

function TerminalDialogBody({ session, onClose }: { session: TerminalSession; onClose: () => void }) {
  // Callback ref in state: Radix portals mount content a render late.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [state, setState] = useState<RunState>({ kind: "running" });
  const stateRef = useRef<RunState>(state);
  stateRef.current = state;

  useEffect(() => {
    if (!host) return;
    const term = new Terminal({
      fontFamily: XTERM_FONT,
      fontSize: 12.5,
      lineHeight: 1.35,
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
        void api.terminalResize(session.terminalId, term.cols, term.rows).catch(() => {});
      } catch {
        /* host not measurable yet */
      }
    };
    // Wait a frame so the dialog has its final size.
    const raf = requestAnimationFrame(() => {
      doFit();
      term.focus();
    });
    const ro = new ResizeObserver(() => doFit());
    ro.observe(host);

    // Clipboard: copy with a selection (Ctrl+C, or Ctrl+Shift+C; ⌘C on macOS); paste with
    // Ctrl+Shift+V (⌘V on macOS). Ctrl+C without a selection still sends ^C to the process.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const k = e.key.toLowerCase();
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
            if (t && stateRef.current.kind === "running") term.paste(t);
          })
          .catch(() => toast.error("Couldn't read the clipboard"));
        return false;
      }
      return true;
    });

    const dataSub = term.onData((d) => {
      if (stateRef.current.kind !== "running") return;
      // One toast per terminal (same id), so typing into a stuck process doesn't spam.
      void api.terminalWrite(session.terminalId, d).catch((e: unknown) =>
        toast.error("Couldn't send input to the terminal", {
          id: `term-write-${session.terminalId}`,
          description: errorMessage(e),
        }),
      );
    });

    const exitLine = (code: number | null) =>
      `\r\n\x1b[2m[process exited${code !== null ? ` with code ${code}` : ""}]\x1b[0m\r\n`;
    let transcript = transcripts.get(session.terminalId);
    const fresh = !transcript;
    if (transcript) {
      term.write(transcript.data);
      if (transcript.exit !== undefined) {
        term.write(exitLine(transcript.exit));
        setState({ kind: "exited", code: transcript.exit });
      }
    } else {
      transcript = { data: "" };
      transcripts.set(session.terminalId, transcript);
    }
    const tr = transcript;
    const detach = attachTerminal(session.terminalId, {
      write: (d) => {
        appendTranscript(tr, d);
        term.write(d);
      },
      exit: (code) => {
        tr.exit = code;
        setState({ kind: "exited", code });
        term.write(exitLine(code));
        void afterExit(session, code);
      },
    });

    // The core reuses a sign-in that's already running for this account without replaying its
    // earlier output; it tells us so (`reused`), so say it once when we have no transcript.
    if (fresh && session.reused) {
      term.write("\x1b[2m(Continuing an existing sign-in… earlier output isn't shown.)\x1b[0m\r\n");
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      dataSub.dispose();
      detach();
      term.dispose();
    };
    // Keyed on the terminal id (the session's other fields are fixed per id): re-opening the
    // same deduplicated terminal keeps it as is instead of tearing it down.
  }, [session.terminalId, host]);

  const close = () => {
    if (stateRef.current.kind === "running") void api.terminalKill(session.terminalId).catch(() => {});
    transcripts.delete(session.terminalId);
    onClose();
  };
  // Stopping a running login/install is destructive: confirm first.
  const [confirmStop, setConfirmStop] = useState(false);
  const what = session.kind === "login" ? "sign-in" : "install";

  const exited = state.kind === "exited";
  const ok = exited && state.code === 0;

  return (
    <DialogContent
      title={
        <span className="flex items-center gap-2">
          <SquareTerminal className="h-4 w-4 text-steel" />
          {session.title}
        </span>
      }
      description={session.subtitle}
      className="w-[min(760px,calc(100vw-16px))]"
      sheet
      // No header X while the process runs (it would kill a login midway); use Stop in the footer.
      hideClose={state.kind === "running"}
      onOpenAutoFocus={(e) => e.preventDefault()}
      // While the process runs (or keys go to xterm), Esc and clicks outside must not
      // close the modal: that would kill a login/install. Use the Close/Cancel button.
      onEscapeKeyDown={(e) => {
        const inTerminal = host?.contains(document.activeElement) ?? false;
        if (inTerminal || stateRef.current.kind === "running") e.preventDefault();
      }}
      onPointerDownOutside={(e) => {
        if (stateRef.current.kind === "running") e.preventDefault();
      }}
      onInteractOutside={(e) => {
        if (stateRef.current.kind === "running") e.preventDefault();
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-4 pt-2 max-sm:px-3">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-code shadow-[inset_0_1px_0_var(--edge)]">
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel/70 px-3">
            <span className="flex gap-1.5" aria-hidden>
              <span className="h-2.5 w-2.5 rounded-full bg-raised" />
              <span className="h-2.5 w-2.5 rounded-full bg-raised" />
              <span className="h-2.5 w-2.5 rounded-full bg-raised" />
            </span>
            <span className="ml-1 font-mono text-[11px] text-steel">
              {session.kind === "login" ? "login" : "install"} · pty
            </span>
            <span className="ml-auto">
              <StatusChip state={state} />
            </span>
          </div>
          <div
            ref={setHost}
            className="xterm-host h-[min(340px,calc(100dvh-260px))] min-h-[180px] w-full max-sm:h-auto max-sm:flex-1"
            aria-label="Terminal"
          />
        </div>
        {session.kind === "login" && !exited && (
          <p className="mt-2.5 text-[12px] text-muted">
            Finish signing in in your browser. If the CLI asks for a code, paste it here and press Enter.
          </p>
        )}
      </div>
      <DialogFooter>
        {exited ? (
          <Button variant={ok ? "primary" : "secondary"} onClick={close}>
            {ok ? "Done" : "Close"}
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => setConfirmStop(true)}>
            Stop {what}
          </Button>
        )}
      </DialogFooter>
      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        danger
        title={`Stop the ${what}?`}
        description={
          session.kind === "login"
            ? "The sign-in process ends and this account stays signed out. You can start it again from Accounts."
            : "The installer is stopped midway. You can run it again from Settings → Providers."
        }
        confirmLabel={`Stop ${what}`}
        cancelLabel="Keep going"
        onConfirm={() => {
          setConfirmStop(false);
          close();
        }}
      />
    </DialogContent>
  );
}

function StatusChip({ state }: { state: RunState }) {
  if (state.kind === "running") {
    return (
      <span className="inline-flex h-5 items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2 text-[11px] font-medium text-accent">
        <Spinner className="h-3 w-3" /> Running
      </span>
    );
  }
  const ok = state.code === 0;
  return (
    <span
      className={
        ok
          ? "inline-flex h-5 items-center gap-1 rounded-full border border-ok/30 bg-ok/10 px-2 text-[11px] font-medium text-ok"
          : "inline-flex h-5 items-center gap-1 rounded-full border border-err/30 bg-err/10 px-2 text-[11px] font-medium text-err"
      }
    >
      {ok ? <CircleCheck className="h-3 w-3" /> : <CircleX className="h-3 w-3" />}
      {ok ? "Completed" : `Exited ${state.code ?? "?"}`}
    </span>
  );
}

async function afterExit(session: TerminalSession, code: number | null) {
  const store = useApp.getState();
  try {
    if (session.kind === "login" && session.accountId) {
      const acc = await api.checkAccount(session.accountId);
      store.upsertAccount(acc);
      if (acc.status?.loggedIn) {
        toast.success(`Signed in to ${acc.name}`, {
          description: [acc.status.label, acc.status.email].filter(Boolean).join(" · ") || undefined,
        });
      } else if (code !== 130 && code !== 143) {
        toast.warning(`${acc.name} is still signed out`, { description: acc.status?.error ?? undefined });
      }
    } else if (session.kind === "install") {
      const providers = await api.detectProviders();
      store.setProviders(providers);
      if (code === 130 || code === 143) return; // cancelled by the user
      if (session.provider) {
        const p = providers.find((x) => x.provider === session.provider);
        if (code === 0 && p?.installed)
          toast.success(`${p.displayName} is ready`, { description: p.version ? `v${p.version}` : undefined });
        else toast.error("Install didn't finish", { description: `Exit code ${code ?? "unknown"}` });
      } else {
        // "Install everything": report how many runtimes are now ready.
        const ready = providers.filter((p) => p.installed && (!p.adapterRequired || p.adapterInstalled)).length;
        if (code === 0)
          toast.success("Agents installed", { description: `${ready} of ${providers.length} providers ready` });
        else
          toast.error("Some installs failed", {
            description: `${ready} of ${providers.length} providers ready · exit code ${code ?? "unknown"}`,
          });
      }
    }
  } catch (e) {
    toast.error("Couldn't refresh status", { description: errorMessage(e) });
  }
}
