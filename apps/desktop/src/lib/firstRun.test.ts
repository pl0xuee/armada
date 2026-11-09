import { describe, expect, it } from "vitest";
import {
  applyExit,
  applyLogLine,
  moveOnAction,
  offeredFirst,
  primaryAction,
  progressNote,
  rowState,
  selectedTools,
  shortReason,
  signInOffers,
  type RowState,
  type Runs,
} from "./firstRun";
import type { Account, Provider, ProviderInfo } from "./types";

const NAMES: Record<string, string> = { claude: "Claude", codex: "ChatGPT (Codex)", grok: "Grok" };
const tool = (provider: Provider, installed: boolean, extra: Partial<ProviderInfo> = {}) =>
  ({
    provider,
    displayName: NAMES[provider],
    installed,
    adapterRequired: false,
    adapterInstalled: false,
    ...extra,
  }) as ProviderInfo;
const account = (provider: Provider, loggedIn: boolean | null, isSystem = true, id = `acc-${provider}`) =>
  ({
    id,
    provider,
    isSystem,
    status: loggedIn === null ? null : { loggedIn },
  }) as Account;

const ALL_MISSING = [tool("claude", false), tool("codex", false), tool("grok", false)];

describe("what is ticked", () => {
  it("ticks the missing tools by default and skips ready ones", () => {
    const list = [tool("claude", true), tool("codex", false), tool("grok", false)];
    expect(selectedTools(list, {}, [])).toEqual(["codex", "grok"]);
  });

  it("leaves out what was unticked", () => {
    expect(selectedTools(ALL_MISSING, {}, ["codex"])).toEqual(["claude", "grok"]);
  });

  it("leaves out tools that are already started or failed (they have their own Retry)", () => {
    const runs: Runs = { claude: { status: "installing" }, codex: { status: "failed", reason: "x" } };
    expect(selectedTools(ALL_MISSING, runs, [])).toEqual(["grok"]);
  });

  it("treats a Claude whose helper is missing as not ready", () => {
    const claude = tool("claude", true, { adapterRequired: true, adapterInstalled: false });
    expect(selectedTools([claude], {}, [])).toEqual(["claude"]);
  });
});

describe("row state", () => {
  it("follows the run, not the launcher file, once an install was started", () => {
    // npm links the launcher before it finishes, so the tool already shows as installed.
    expect(rowState(tool("grok", true), { status: "failed", reason: "x" })).toBe("failed");
    expect(rowState(tool("grok", true), { status: "installing" })).toBe("installing");
    expect(rowState(tool("grok", true), { status: "queued" })).toBe("queued");
  });
  it("shows a finished install as ready before the next detect arrives", () => {
    expect(rowState(tool("grok", false), { status: "done" })).toBe("ready");
    expect(rowState(tool("grok", true), { status: "done" })).toBe("ready");
  });
  it("follows the run while the tool is missing", () => {
    expect(rowState(tool("grok", false), { status: "queued" })).toBe("queued");
    expect(rowState(tool("grok", false), { status: "installing" })).toBe("installing");
    expect(rowState(tool("grok", false), { status: "failed" })).toBe("failed");
    expect(rowState(tool("grok", false), undefined)).toBe("idle");
  });
  it("trusts what was detected only when nothing was run", () => {
    expect(rowState(tool("grok", true), undefined)).toBe("ready");
    const claude = tool("claude", true, { adapterRequired: true, adapterInstalled: false });
    expect(rowState(claude, undefined)).toBe("idle");
  });
  it("a retry replaces a failed run", () => {
    // store/installs.ts start() sets the run to queued, which is what the row then shows.
    expect(rowState(tool("grok", true), { status: "queued" })).toBe("queued");
  });
});

describe("main button", () => {
  it("installs the ticked tools", () => {
    expect(primaryAction(["idle", "idle", "ready"], 2)).toEqual({
      kind: "install",
      label: "Install 2 selected",
      disabled: false,
    });
  });

  it("is off, with a plain reason, when nothing is ticked and nothing is ready", () => {
    const a = primaryAction(["idle", "idle"], 0);
    expect(a.disabled).toBe(true);
    expect(a.reason).toBe("Tick at least one tool to install.");
  });

  it("says to try again when the only tools failed", () => {
    const a = primaryAction(["failed", "failed"], 0);
    expect(a.disabled).toBe(true);
    expect(a.reason).toMatch(/again/);
  });

  it("is a plain Continue when what was chosen is ready", () => {
    expect(primaryAction(["ready", "idle"], 0)).toEqual({ kind: "continue", label: "Continue", disabled: false });
    expect(primaryAction(["ready", "ready", "ready"], 0).label).toBe("Continue");
  });

  it("does not unlock Continue for an install that is still running or failed", () => {
    // The row states come from rowState, so a failed run is never "ready" here.
    const states = [
      rowState(tool("grok", true), { status: "installing" }),
      rowState(tool("claude", true), { status: "failed" }),
    ];
    expect(primaryAction(states, 0).kind).toBe("install");
    expect(primaryAction(states, 0).disabled).toBe(true);
  });

  it("waits while the first tools install, then unlocks while the others still install", () => {
    const waiting = primaryAction(["installing", "queued"], 0);
    expect(waiting).toMatchObject({ kind: "install", disabled: true });
    expect(waiting.reason).toBeTruthy();
    expect(primaryAction(["ready", "installing", "queued"], 0)).toMatchObject({ kind: "continue", disabled: false });
  });
});

describe("the way past the step", () => {
  const move = (states: RowState[], selected: number) => moveOnAction(states, primaryAction(states, selected));
  it("is there beside the install button, and says Skip for now when nothing is ready", () => {
    expect(move(["idle", "idle"], 2)).toEqual({ label: "Skip for now" });
    expect(move(["idle", "idle"], 0)).toEqual({ label: "Skip for now" });
    expect(move(["failed", "failed"], 0)).toEqual({ label: "Skip for now" });
    expect(move(["installing", "queued"], 0)).toEqual({ label: "Skip for now" });
  });
  it("says Continue when something is ready but more is ticked", () => {
    expect(move(["ready", "idle"], 1)).toEqual({ label: "Continue" });
    expect(move(["ready", "failed"], 0)).toBeNull();
  });
  it("is not repeated when the main button already is Continue", () => {
    expect(move(["ready", "idle"], 0)).toBeNull();
  });
});

describe("progress note", () => {
  it("only appears once something is ready and others still run", () => {
    expect(progressNote(["installing", "queued"])).toBeNull();
    expect(progressNote(["ready", "ready"])).toBeNull();
    expect(progressNote(["ready", "installing"])).toMatch(/One more/);
    expect(progressNote(["ready", "installing", "queued"])).toMatch(/2 more/);
  });
});

describe("reading the installer's log", () => {
  const providers = ALL_MISSING;
  const line = (runs: Runs, l: string) => applyLogLine(runs, l, providers);

  it("marks a tool as installing, then ready, and reports who finished", () => {
    let r = line({}, "\x1b[0mSetting up Claude");
    expect(r.runs.claude?.status).toBe("installing");
    r = line(r.runs, "\x1b[32m✓ Claude is ready (2.1.3)\x1b[0m");
    expect(r.runs.claude?.status).toBe("done");
    expect(r.finished).toBe("claude");
  });

  it("does not count a tool that was already there as newly installed", () => {
    const r = line({ grok: { status: "queued" } }, "✓ Grok is already installed.");
    expect(r.runs.grok?.status).toBe("done");
    expect(r.finished).toBeUndefined();
  });

  it("keeps a short reason for a failed one", () => {
    const r = line({}, "\x1b[31m✗ ChatGPT (Codex): couldn't reach the npm registry for codex: timed out\x1b[0m");
    expect(r.runs.codex).toEqual({
      status: "failed",
      reason: "couldn't reach the npm registry for codex: timed out",
    });
  });

  it("ignores the summary line and names it doesn't know", () => {
    expect(line({}, "✗ Some installs failed: Claude, Grok").runs).toEqual({});
    expect(line({}, "Setting up Mystery").runs).toEqual({});
    expect(line({}, "▸ Installing @openai/codex@1…").runs).toEqual({});
  });

  it("cuts long reasons to one line", () => {
    expect(shortReason("first line\nsecond line")).toBe("first line");
    expect(shortReason("x".repeat(300)).length).toBeLessThanOrEqual(140);
    expect(shortReason("")).toBe("It didn't finish.");
  });
});

describe("the lines the core prints", () => {
  // crates/kvistcode-core/src/toolchain.rs pins the same literals in its test
  // `log_lines_match_what_the_app_reads`. Change both together.
  const CORE_LINES = [
    "Setting up Claude",
    "✓ Claude is ready (2.1.3)",
    "✓ Claude is already installed.",
    "✗ Claude: something went wrong",
  ];
  it("are read as installing, ready, already there and failed", () => {
    const p = [tool("claude", false)];
    const [setting, ready, already, failed] = CORE_LINES.map((l) => applyLogLine({}, l, p));
    expect(setting.runs.claude?.status).toBe("installing");
    expect(ready).toMatchObject({ runs: { claude: { status: "done" } }, finished: "claude" });
    expect(already.runs.claude?.status).toBe("done");
    expect(already.finished).toBeUndefined();
    expect(failed.runs.claude).toEqual({ status: "failed", reason: "something went wrong" });
  });
});

describe("when an install job ends", () => {
  it("fails what was left waiting or running if the job failed", () => {
    const runs: Runs = { claude: { status: "done" }, codex: { status: "installing" }, grok: { status: "queued" } };
    const next = applyExit(runs, ["claude", "codex", "grok"], 1);
    expect(next.claude?.status).toBe("done");
    expect(next.codex?.status).toBe("failed");
    expect(next.grok).toMatchObject({ status: "failed", reason: expect.stringMatching(/stopped/) });
  });

  it("settles what was left as done if the job succeeded", () => {
    expect(applyExit({ codex: { status: "queued" } }, ["codex"], 0).codex?.status).toBe("done");
  });

  it("leaves other jobs' tools alone", () => {
    const runs: Runs = { grok: { status: "installing" } };
    expect(applyExit(runs, ["claude"], 1)).toEqual(runs);
  });
});

describe("sign-in right after install", () => {
  const ready = [tool("claude", true), tool("codex", true), tool("grok", true)];

  it("offers the newly installed tools first, in the order they finished", () => {
    const accounts = [account("claude", null), account("codex", false), account("grok", false)];
    const offers = signInOffers(["grok", "claude"], ready, accounts);
    expect(offers.map((a) => a.provider)).toEqual(["grok", "claude"]);
  });

  it("skips anyone already signed in", () => {
    const accounts = [account("claude", true), account("codex", false)];
    expect(signInOffers(["claude", "codex"], ready, accounts).map((a) => a.provider)).toEqual(["codex"]);
  });

  it("offers nothing for a tool that is not ready, for custom and local agents, or for extra accounts", () => {
    const accounts = [
      account("claude", false),
      account("custom", false),
      account("local", false),
      account("codex", false, false, "acc-codex-work"),
    ];
    expect(signInOffers(["claude"], [tool("claude", false)], accounts)).toEqual([]);
    expect(signInOffers(["custom", "local", "codex"], ready, accounts)).toEqual([]);
  });

  it("offers nothing for a tool whose install failed or is still running, even with its launcher in place", () => {
    const accounts = [account("claude", false), account("codex", false), account("grok", false)];
    const runs: Runs = { claude: { status: "failed", reason: "x" }, codex: { status: "installing" } };
    expect(signInOffers(["claude", "codex", "grok"], ready, accounts, runs).map((a) => a.provider)).toEqual(["grok"]);
    expect(
      signInOffers(["claude", "codex"], ready, accounts, { claude: { status: "done" } }).map((a) => a.provider),
    ).toEqual(["claude", "codex"]);
  });

  it("is one offer when exactly one tool was installed", () => {
    const accounts = [account("claude", false), account("codex", false)];
    expect(signInOffers(["codex"], ready, accounts)).toHaveLength(1);
  });

  it("puts the offered accounts first in the list", () => {
    const accounts = [account("claude", true), account("codex", false), account("grok", false)];
    const offers = signInOffers(["grok", "codex"], ready, accounts);
    expect(offeredFirst(accounts, offers).map((a) => a.provider)).toEqual(["grok", "codex", "claude"]);
    expect(offeredFirst(accounts, [])).toEqual(accounts);
  });
});
