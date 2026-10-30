// Typed wrappers around the Rust commands in apps/desktop/src-tauri/src/commands.rs.
// Every backend call in the UI goes through here.
//
// Outside Tauri (plain `npm run dev` in a browser) every call is routed to an
// in-memory mock backend (./mock.ts) so the UI can be developed and reviewed
// without the Rust side. The mock is code-split and never loaded inside Tauri.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  CheckpointList,
  QuestionAnswers,
  RestorePreview,
  RestoreResult,
  Account,
  Agent,
  AgentDiff,
  AppState,
  Attachment,
  ArmadaEvent,
  AttentionReason,
  CreateAccountRequest,
  CommitSummary,
  PrPrompt,
  PrStatus,
  CreateAgentRequest,
  CustomAgent,
  LocalKind,
  LocalProbe,
  McpServer,
  PullProgress,
  Provider,
  ProjectScript,
  ProviderInfo,
  RemoteStatus,
  Schedule,
  SearchHit,
  Settings,
  ShareLink,
  ShipResult,
  BaseBranchStatus,
  TimelineItem,
  UpdateInfo,
  VoiceAssistantUsage,
  VoiceDownloadEvent,
  VoiceInputDevice,
  VoiceStatus,
  VoiceTranscript,
} from "./types";
import { onVoiceBus } from "./voiceBus";
import type { VaEvent } from "./voiceAssistant";

export const EVENT_CHANNEL = "armada://event";

export interface ListItemsOptions {
  beforeSeq?: number;
  limit?: number;
}

/**
 * The browser mock ships only in dev, or in builds with VITE_ARMADA_MOCK=1 (for UI review);
 * otherwise this is statically false and the mock chunk is dropped from the bundle.
 */
const MOCK_ENABLED = import.meta.env.DEV || import.meta.env.VITE_ARMADA_MOCK === "1";

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const tauriApi = {
  // state
  getState: () => invoke<AppState>("get_state"),
  /**
   * Timeline items, oldest first. With `limit`, returns the newest `limit` items (tail-first);
   * with `beforeSeq`, only items with seq < beforeSeq (page up).
   */
  listItems: (agentId: string, opts?: ListItemsOptions) =>
    invoke<TimelineItem[]>("list_items", { agentId, beforeSeq: opts?.beforeSeq ?? null, limit: opts?.limit ?? null }),
  search: (query: string) => invoke<SearchHit[]>("search", { query }),

  // agents
  createAgent: (req: CreateAgentRequest) => invoke<Agent>("create_agent", { req }),
  sendPrompt: (agentId: string, text: string, attachments?: Attachment[]) =>
    invoke<void>("send_prompt", { agentId, text, attachments: attachments ?? [] }),
  /** Loads an image file an agent referenced (relative to its cwd; images ≤10 MB in the agent's folders or temp dir). */
  readImage: (agentId: string, path: string) => invoke<Attachment>("read_image", { agentId, path }),
  /** Images on the system clipboard, read natively (fallback when a paste event carries no image file; Linux only). */
  readClipboardImages: (agentId?: string) =>
    invoke<{ attachments: Attachment[]; problems: string[] }>("read_clipboard_images", { agentId: agentId ?? null }),
  /** Fuzzy file search in the agent's cwd: top 50 relative paths. */
  listFiles: (agentId: string, query: string) => invoke<string[]>("list_files", { agentId, query }),
  /** Starts a helper agent beside a busy one: runs now, in parallel, on a copy of the main agent's files. */
  spawnHelper: (parentId: string, prompt: string, attachments?: Attachment[]) =>
    invoke<Agent>("spawn_helper", { parentId, prompt, attachments: attachments ?? [] }),
  /** Merges the helper and its main agent now (when both are idle enough to do so). */
  syncHelper: (helperId: string) => invoke<Agent>("sync_helper", { helperId }),
  /** After a merge conflict: asks the main agent to resolve it. */
  askMainToMerge: (helperId: string) => invoke<void>("ask_main_to_merge", { helperId }),
  cancelTurn: (agentId: string) => invoke<void>("cancel_turn", { agentId }),
  respondPermission: (agentId: string, requestId: string, optionId: string) =>
    invoke<void>("respond_permission", { agentId, requestId, optionId }),
  resumeAgent: (agentId: string, autoContinue: boolean) => invoke<void>("resume_agent", { agentId, autoContinue }),
  stopAgent: (agentId: string) => invoke<void>("stop_agent", { agentId }),
  /**
   * With removeWorktree and no force, fails with "Unsaved work: …" when the worktree has
   * uncommitted changes or unmerged commits; retry with force to discard them.
   */
  deleteAgent: (agentId: string, removeWorktree: boolean, force?: boolean) =>
    invoke<void>("delete_agent", { agentId, removeWorktree, force: force ?? false }),
  renameAgent: (agentId: string, title: string) => invoke<void>("rename_agent", { agentId, title }),
  archiveAgent: (agentId: string, archived: boolean) => invoke<void>("archive_agent", { agentId, archived }),
  markRead: (agentId: string) => invoke<void>("mark_read", { agentId }),
  /** Triage "Done": records acknowledgedAt and clears unread; new activity brings it back. */
  acknowledgeAgent: (agentId: string) => invoke<void>("acknowledge_agent", { agentId }),
  /** Composer choices remembered per provider identity, applied to new agents. */
  configDefaults: () => invoke<Record<string, Record<string, string>>>("config_defaults"),
  /**
   * Forgets remembered composer choices (one provider identity, or all). `clearAgents` also clears each
   * agent's own saved choices.
   */
  clearConfigDefaults: (key?: string, clearAgents?: boolean) =>
    invoke<Record<string, Record<string, string>>>("clear_config_defaults", { key, clearAgents }),
  setAgentConfig: (agentId: string, optionId: string, value: string) =>
    invoke<void>("set_agent_config", { agentId, optionId, value }),
  /** Hand the agent's work to another provider/account with an instruction. */
  handoffAgent: (
    agentId: string,
    provider: Provider,
    accountId: string,
    instruction: string,
    customAgentId?: string | null,
  ) =>
    invoke<Agent>("handoff_agent", {
      agentId,
      provider,
      accountId,
      instruction,
      customAgentId: customAgentId ?? null,
    }),
  /** Move the agent (and its session) to another account of the same provider. */
  switchAccount: (agentId: string, accountId: string) => invoke<Agent>("switch_account", { agentId, accountId }),
  /** Shows a native save dialog (Markdown or JSON) and writes the transcript; returns the saved path, or null if cancelled. */
  exportAgent: (agentId: string) => invoke<string | null>("export_agent", { agentId }),
  /** A plain-text diagnostics report for bug reports (secrets, emails and tokens removed; home shown as ~). */
  diagnostics: () => invoke<string>("diagnostics"),
  /** Writes the diagnostics report to the Downloads folder, reveals it and returns its path. */
  saveDiagnostics: () => invoke<string>("save_diagnostics"),
  /** Removes a queued prompt; returns its text and images (null if it already ran). */
  removeQueued: (agentId: string, queuedId: string) =>
    invoke<{ text: string; attachments: Attachment[] } | null>("remove_queued", { agentId, queuedId }),
  /** Unpauses the queue and runs its head if the agent is idle. */
  resumeQueue: (agentId: string) => invoke<void>("resume_queue", { agentId }),
  /** Removes every queued message; returns how many were removed. */
  clearQueue: (agentId: string) => invoke<number>("clear_queue", { agentId }),
  /** Interrupts the running turn and runs this queued prompt next. */
  /** Answer a question item; `answers: null` skips it (the agent is told you didn't answer). */
  answerQuestion: (agentId: string, requestId: string, answers: QuestionAnswers | null) =>
    invoke<void>("answer_question", { agentId, requestId, answers }),
  /** Into the running turn when the agent can take it; `interrupt` stops the turn and runs it next. */
  sendQueuedNow: (agentId: string, queuedId: string, interrupt = false) =>
    invoke<void>("send_queued_now", { agentId, queuedId, interrupt }),
  /** Tell the backend what the user is looking at (for smart-mute). */
  setFocus: (agentId: string | null) => invoke<void>("set_focus", { agentId }),
  /** Soft "the agent you're watching finished a long task" chime (backend applies sound settings). */
  chimeWatched: () => invoke<void>("chime_watched"),
  /** Window title for taskbars / WM bars / alt-tab. */
  setWindowTitle: (title: string) => invoke<void>("set_window_title", { title }),

  // review / git
  getDiff: (agentId: string) => invoke<AgentDiff>("get_diff", { agentId }),

  // checkpoints (rewind)
  listCheckpoints: (agentId: string) => invoke<CheckpointList>("list_checkpoints", { agentId }),
  /** What restoring would change: files that differ between now and the checkpoint. */
  previewCheckpoint: (agentId: string, checkpointId: string) =>
    invoke<RestorePreview>("preview_checkpoint", { agentId, checkpointId }),
  /** Saves the current state, then restores the checkpoint. Restoring `safetyId` undoes it. */
  restoreCheckpoint: (agentId: string, checkpointId: string) =>
    invoke<RestoreResult>("restore_checkpoint", { agentId, checkpointId }),
  commitAgent: (agentId: string, message: string, exclude?: string[]) =>
    invoke<CommitSummary>("commit_agent", { agentId, message, exclude }),
  /** New files a commit would add whose names look like secrets (.env, *.pem, ...). */
  secretLookingFiles: (agentId: string) => invoke<string[]>("secret_looking_files", { agentId }),
  mergeAgent: (agentId: string) => invoke<string>("merge_agent", { agentId }),
  /**
   * Reverse-applies a slice of the agent's diff patch: a file's whole section, or its header
   * (from `diff --git` to the first `@@`) plus one hunk. All or nothing.
   */
  revertPatch: (agentId: string, patch: string) => invoke<void>("revert_patch", { agentId, patch }),
  /** Commits anything uncommitted (message defaults to the title), then merges into the base branch. */
  shipAgent: (agentId: string, message: string, exclude?: string[]) =>
    invoke<ShipResult>("ship_agent", { agentId, message, exclude }),
  baseBranchStatus: (agentId: string) => invoke<BaseBranchStatus>("base_branch_status", { agentId }),
  pushBaseBranch: (agentId: string) => invoke<BaseBranchStatus>("push_base_branch", { agentId }),
  createPr: (agentId: string, title: string, body: string) => invoke<string>("create_pr", { agentId, title, body }),
  /** PR + CI status of the agent's branch (cached; never rejects for gh/auth/network problems). */
  prStatus: (agentId: string, force = false) => invoke<PrStatus>("pr_status", { agentId, force }),
  /** Editable "Fix CI" prompt: failing checks plus trimmed failing-job logs. Rejects when nothing is failing. */
  prFixCiPrompt: (agentId: string) => invoke<PrPrompt>("pr_fix_ci_prompt", { agentId }),
  /**
   * Editable prompt with the PR's review feedback. Rejects when there's nothing to address.
   * Comments from people outside the project are left out (and counted in `omitted`) unless `includeOutside`.
   */
  prReviewPrompt: (agentId: string, includeOutside = false) =>
    invoke<PrPrompt>("pr_review_prompt", { agentId, includeOutside }),
  discardWorktree: (agentId: string) => invoke<void>("discard_worktree", { agentId }),

  // accounts
  createAccount: (req: CreateAccountRequest) => invoke<Account>("create_account", { req }),
  /** Replaces an API-key account's key (running agents keep the old key until they restart). */
  updateAccountKey: (accountId: string, apiKey: string) => invoke<Account>("update_account_key", { accountId, apiKey }),
  updateAccount: (accountId: string, name: string, color: string) =>
    invoke<Account>("update_account", { accountId, name, color }),
  deleteAccount: (accountId: string) => invoke<void>("delete_account", { accountId }),
  checkAccount: (accountId: string) => invoke<Account>("check_account", { accountId }),
  /** Starts the provider's own login flow in a PTY; returns a terminal id. */
  loginAccount: (accountId: string) => invoke<{ terminalId: string; reused: boolean }>("login_account", { accountId }),

  // local model servers
  /** Probes the default Ollama and LM Studio addresses. */
  detectLocalServers: () => invoke<LocalProbe[]>("detect_local_servers"),
  /** Probes one server address (`apiKey` is its optional bearer token). */
  probeLocalServer: (kind: LocalKind, baseUrl: string, apiKey?: string | null) =>
    invoke<LocalProbe>("probe_local_server", { kind, baseUrl, apiKey: apiKey ?? null }),
  /** Live model list of an existing local account's server. */
  probeLocalAccount: (accountId: string) => invoke<LocalProbe>("probe_local_account", { accountId }),
  /** Downloads a model into Ollama; resolves when done, rejects on failure or cancel. */
  pullLocalModel: (baseUrl: string, model: string, pullId: string, onProgress: (p: PullProgress) => void) => {
    const channel = new Channel<PullProgress>();
    channel.onmessage = onProgress;
    return invoke<void>("pull_local_model", { baseUrl, model, pullId, onProgress: channel });
  },
  cancelLocalPull: (pullId: string) => invoke<void>("cancel_local_pull", { pullId }),

  // providers
  detectProviders: () => invoke<ProviderInfo[]>("detect_providers"),
  /** Runs the install command in a PTY; returns a terminal id. */
  installProvider: (provider: Provider) => invoke<string>("install_provider", { provider }),
  /** Installs every missing CLI/adapter (private Node.js if needed); returns a terminal id. */
  installMissing: () => invoke<string>("install_missing"),

  // terminals (login / install)
  terminalWrite: (terminalId: string, data: string) => invoke<void>("terminal_write", { terminalId, data }),
  terminalResize: (terminalId: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { terminalId, cols, rows }),
  terminalKill: (terminalId: string) => invoke<void>("terminal_kill", { terminalId }),
  // workspace panel: a shell (or a detected project script) in the agent's own folder
  workspaceTerminalOpen: (agentId: string, scriptId?: string) =>
    invoke<string>("workspace_terminal_open", { agentId, scriptId: scriptId ?? null }),
  workspaceScripts: (agentId: string) => invoke<ProjectScript[]>("workspace_scripts", { agentId }),
  /** Subset of `ports` accepting TCP connections on loopback (Preview tab). */
  probePorts: (ports: number[]) => invoke<number[]>("probe_ports", { ports }),
  /** Like probePorts, but says which loopback families (127.0.0.1 / [::1]) accept on each live port. */
  probeLoopback: (ports: number[]) => invoke<PortFamilies[]>("probe_loopback", { ports }),
  /**
   * Starts (or reuses) the agent's local Preview proxy in front of a loopback dev server. The proxy adds
   * the page tools (screenshots, console, element picker); `url` is what the iframe loads.
   */
  previewProxyStart: (agentId: string, target: string) =>
    invoke<PreviewProxyInfo>("preview_proxy_start", { agentId, target }),
  /** Stops the agent's Preview proxy; with `token`, only if it is still that session. */
  previewProxyStop: (agentId: string, token?: string) =>
    invoke<void>("preview_proxy_stop", { agentId, token: token ?? null }),

  // settings & attention
  updateSettings: (settings: Settings) => invoke<Settings>("update_settings", { settings }),
  setInterfaceZoom: (percent: number) => invoke<void>("set_interface_zoom", { percent }),
  previewSound: (reason: AttentionReason) => invoke<void>("preview_sound", { reason }),
  /** Shows a test notification; also sends a phone push to `ntfyUrl` (or the saved one) when set. */
  testNotification: (ntfyUrl?: string | null) => invoke<void>("test_notification", { ntfyUrl: ntfyUrl ?? null }),
  openPath: (path: string) => invoke<void>("open_path", { path }),

  // schedules
  listSchedules: () => invoke<Schedule[]>("list_schedules"),
  /** Validates and saves; returns the saved schedule (with id). */
  saveSchedule: (schedule: Schedule) => invoke<Schedule>("save_schedule", { schedule }),
  deleteSchedule: (scheduleId: string) => invoke<void>("delete_schedule", { scheduleId }),
  runSchedule: (scheduleId: string) => invoke<Agent>("run_schedule", { scheduleId }),

  // custom agents
  /** Spawns the agent and runs the ACP handshake; resolves to e.g. "Gemini CLI 0.52.0 (ACP v1)". */
  testCustomAgent: (agent: CustomAgent) => invoke<string>("test_custom_agent", { agent }),
  /** Starts the MCP server and lists its tools; resolves to e.g. "filesystem 1.2.0 · 12 tools". */
  testMcpServer: (server: McpServer) => invoke<string>("test_mcp_server", { server }),
  /** Git repositories under the home folder, newest first. */
  discoverProjects: () => invoke<string[]>("discover_projects"),
  /** True when the folder is inside a git work tree with at least one commit (~ is expanded). */
  isGitRepo: (path: string) => invoke<boolean>("is_git_repo", { path }),

  // remote control / share links
  remoteStatus: () => invoke<RemoteStatus>("remote_status"),
  remoteRotateToken: () => invoke<RemoteStatus>("remote_rotate_token"),
  remoteRevokeDevice: (id: string) => invoke<RemoteStatus>("remote_revoke_device", { id }),
  /** `hours`: 1, 24 or 168 (7 days). */
  createShareLink: (agentId: string, hours?: number) => invoke<ShareLink>("create_share_link", { agentId, hours }),
  revokeShareLink: (id: string) => invoke<void>("revoke_share_link", { id }),

  // updates
  checkForUpdate: () => invoke<UpdateInfo | null>("check_for_update"),
  /** Downloads, installs and restarts the app; progress via update_progress events. */
  installUpdate: () => invoke<void>("install_update"),

  // voice dictation (local speech-to-text; audio never leaves the device)
  voiceStatus: () => invoke<VoiceStatus>("voice_status"),
  voiceListDevices: () => invoke<VoiceInputDevice[]>("voice_list_devices"),
  /** Downloads a model (SHA-256 verified); progress via voice-download events. Resolves when done. */
  voiceDownloadModel: (id: string) => invoke<void>("voice_download_model", { id }),
  voiceCancelDownload: () => invoke<void>("voice_cancel_download"),
  voiceDeleteModel: (id: string) => invoke<void>("voice_delete_model", { id }),
  /** Opens the microphone; level meter via voice-level events. */
  voiceStart: () => invoke<void>("voice_start"),
  /** Stops recording and transcribes. */
  voiceStop: () => invoke<VoiceTranscript>("voice_stop"),
  voiceCancel: () => invoke<void>("voice_cancel"),

  // voice assistant (OpenAI Realtime; audio is sent to OpenAI; the key never leaves the backend)
  vaStart: () => invoke<void>("va_start"),
  vaStop: () => invoke<void>("va_stop"),
  vaSetMuted: (muted: boolean) => invoke<void>("va_set_muted", { muted }),
  vaConfirm: (id: string, accept: boolean) => invoke<void>("va_confirm", { id, accept }),
  vaActive: () => invoke<boolean>("va_active"),
  vaUsage: () => invoke<VoiceAssistantUsage>("va_usage"),
  vaVoices: () => invoke<string[]>("va_voices"),
};

export type ArmadaApi = typeof tauriApi;

type AnyAsyncFn = (...args: unknown[]) => Promise<unknown>;

let mockModule: Promise<typeof import("./mock")> | null = null;
const loadMock = (): Promise<typeof import("./mock")> =>
  MOCK_ENABLED
    ? (mockModule ??= import("./mock"))
    : Promise.reject(new Error("Armada's core isn't available here. Open the Armada desktop app."));

/** Same surface as `tauriApi`, each call forwarded to the lazily loaded mock backend. */
function createMockProxy(): ArmadaApi {
  const out: Record<string, AnyAsyncFn> = {};
  for (const key of Object.keys(tauriApi) as (keyof ArmadaApi)[]) {
    out[key] = (...args: unknown[]) => loadMock().then((m) => (m.mockApi[key] as unknown as AnyAsyncFn)(...args));
  }
  return out as unknown as ArmadaApi;
}

export interface PreviewProxyInfo {
  url: string;
  token: string;
  /** Browser mock: no proxy runs, the page loads directly (page tools only work if the page includes the agent). */
  simulated?: boolean;
}

export interface PortFamilies {
  port: number;
  v4: boolean;
  v6: boolean;
}

export const api: ArmadaApi = isTauri() ? tauriApi : createMockProxy();

export function onArmadaEvent(cb: (e: ArmadaEvent) => void): Promise<UnlistenFn> {
  // The core batches events: a payload is an array per dispatcher cycle (a single object is accepted too).
  const deliver = (payload: ArmadaEvent | ArmadaEvent[]) => {
    if (Array.isArray(payload)) for (const e of payload) cb(e);
    else cb(payload);
  };
  if (!isTauri()) return loadMock().then((m) => m.subscribeMock(deliver));
  return listen<ArmadaEvent | ArmadaEvent[]>(EVENT_CHANNEL, (e) => deliver(e.payload));
}

/** Voice events: microphone level while recording, model download progress, the length limit. */
export function onVoiceLevel(cb: (e: { level: number; elapsedMs: number }) => void): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(onVoiceBus("voice-level", cb));
  return listen<{ level: number; elapsedMs: number }>("voice-level", (e) => cb(e.payload));
}

export function onVaEvent(cb: (e: VaEvent) => void): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(onVoiceBus("va-event", cb));
  return listen<VaEvent>("va-event", (e) => cb(e.payload));
}

export function onVoiceLimit(cb: () => void): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(onVoiceBus("voice-limit", cb));
  return listen("voice-limit", () => cb());
}

export function onVoiceDownload(cb: (e: VoiceDownloadEvent) => void): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(onVoiceBus("voice-download", cb));
  return listen<VoiceDownloadEvent>("voice-download", (e) => cb(e.payload));
}
