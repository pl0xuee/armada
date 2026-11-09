// First-run installs: which tools are ticked, what each install is doing, and its log.
// Lives outside the setup screen so an install keeps going (and stays visible) when the
// person moves on to the next step. The pure parts are in lib/firstRun.ts.
import { toast } from "sonner";
import { create } from "zustand";
import { api } from "@/lib/api";
import { applyExit, applyLogLine, stripAnsi, type Runs } from "@/lib/firstRun";
import { attachTerminal } from "@/lib/terminal-bus";
import type { Provider } from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { useApp } from "@/store/app";

/** The details text keeps the newest part only. */
const LOG_MAX = 120_000;

/** Which install job (terminal) last took each tool, so a late "finished" from an older job can't touch a retry. */
const owners: Partial<Record<Provider, string>> = {};

interface InstallsState {
  runs: Runs;
  /** Providers the person unticked (the rest of the missing ones are ticked). */
  unticked: Provider[];
  /** Tools that finished installing in this run of the app, in order: the sign-in step offers them first. */
  installed: Provider[];
  /** Everything the installer printed, plain text. */
  log: string;
  toggle: (p: Provider) => void;
  start: (providers: Provider[]) => Promise<void>;
}

export const useInstalls = create<InstallsState>((set, get) => ({
  runs: {},
  unticked: [],
  installed: [],
  log: "",

  toggle: (p) =>
    set((s) => ({ unticked: s.unticked.includes(p) ? s.unticked.filter((x) => x !== p) : [...s.unticked, p] })),

  start: async (providers) => {
    if (providers.length === 0) return;
    // Show them as waiting right away; the installer says when each one really starts.
    set((s) => {
      const runs = { ...s.runs };
      for (const p of providers) runs[p] = { status: "queued" };
      return { runs };
    });
    try {
      const id = await api.installProviders(providers);
      for (const p of providers) owners[p] = id;
      let partial = "";
      const feed = (data: string) => {
        const text = partial + data;
        const lines = text.split(/\r?\n/);
        partial = lines.pop() ?? "";
        if (lines.length === 0) return;
        const infos = useApp.getState().providers;
        let { runs, installed } = get();
        for (const line of lines) {
          const r = applyLogLine(runs, line, infos);
          runs = r.runs;
          if (r.finished && !installed.includes(r.finished)) installed = [...installed, r.finished];
        }
        const plain = lines.map(stripAnsi).join("\n") + "\n";
        const log = (get().log + plain).slice(-LOG_MAX);
        set({ runs, installed, log });
      };
      // No dialog hosts this terminal: its output is read here, so closing a window can never stop it.
      let detach: (() => void) | undefined;
      let exited = false;
      detach = attachTerminal(id, {
        write: feed,
        exit: (code) => {
          exited = true;
          if (partial) feed("\n");
          const mine = providers.filter((p) => owners[p] === id);
          set((s) => ({ runs: applyExit(s.runs, mine, code) }));
          detach?.();
        },
      });
      if (exited) detach();
    } catch (e) {
      set((s) => {
        const runs = { ...s.runs };
        for (const p of providers) delete runs[p];
        return { runs };
      });
      toast.error("Couldn't start the installer", { description: errorMessage(e) });
    }
  },
}));
