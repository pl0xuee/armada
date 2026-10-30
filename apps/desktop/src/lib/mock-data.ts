// Seed data for the browser mock backend. Everything here is fictional.
import { createTwoFilesPatch } from "diff";
import type {
  Account,
  Attachment,
  Agent,
  AgentDiff,
  ConfigOption,
  PermissionOption,
  Provider,
  ProviderInfo,
  QueuedPrompt,
  Schedule,
  Settings,
  SlashCommand,
  TimelineItem,
} from "./types";

const NOW = Date.now();
const min = (m: number) => NOW - m * 60_000;

// ---------------------------------------------------------------- accounts

export function seedAccounts(): Account[] {
  return [
    {
      id: "acc-claude-sys",
      provider: "claude",
      name: "Personal",
      color: "#D97757",
      authKind: "default",
      isSystem: true,
      configDir: null,
      createdAt: min(60 * 24 * 30),
      status: {
        loggedIn: true,
        label: "Claude Max",
        email: "sam@fleet.dev",
        plan: "Max 5x",
        checkedAt: min(3),
        error: null,
      },
      usage: null,
    },
    {
      id: "acc-claude-work",
      provider: "claude",
      name: "Work",
      color: "#A78BFA",
      authKind: "oauth",
      isSystem: false,
      configDir: "~/.local/share/armada/profiles/acc-claude-work/claude",
      createdAt: min(60 * 24 * 12),
      status: {
        loggedIn: true,
        label: "Claude Max",
        email: "sam@acme.io",
        plan: "Max 20x",
        checkedAt: min(3),
        error: null,
      },
      usage: {
        primary: { usedPercent: 12, windowMins: 300, resetsAt: NOW + 3 * 3600_000 + 40 * 60_000 },
        secondary: { usedPercent: 74, windowMins: 10080, resetsAt: NOW + 3 * 86_400_000 },
        plan: null,
        updatedAt: min(1),
      },
    },
    {
      id: "acc-codex-sys",
      provider: "codex",
      name: "Personal",
      color: "#10A37F",
      authKind: "default",
      isSystem: true,
      configDir: null,
      createdAt: min(60 * 24 * 30),
      status: {
        loggedIn: true,
        label: "ChatGPT Pro",
        email: "sam@fleet.dev",
        plan: "Pro",
        checkedAt: min(5),
        error: null,
      },
      usage: {
        primary: { usedPercent: 42, windowMins: 300, resetsAt: NOW + 2 * 3600_000 + 14 * 60_000 },
        secondary: { usedPercent: 18, windowMins: 10080, resetsAt: NOW + 4 * 86_400_000 },
        plan: "pro",
        updatedAt: min(1),
      },
    },
    {
      id: "acc-codex-api",
      provider: "codex",
      name: "API (CI budget)",
      color: "#F5B544",
      authKind: "api_key",
      isSystem: false,
      configDir: "~/.local/share/armada/profiles/acc-codex-api/codex",
      createdAt: min(60 * 24 * 4),
      status: {
        loggedIn: true,
        label: "OpenAI API key",
        email: null,
        plan: "Pay as you go",
        checkedAt: min(40),
        error: null,
      },
      usage: null,
    },
    {
      id: "acc-grok-sys",
      provider: "grok",
      name: "Personal",
      color: "#E5E7EB",
      authKind: "default",
      isSystem: true,
      configDir: null,
      createdAt: min(60 * 24 * 30),
      status: {
        loggedIn: false,
        label: null,
        email: null,
        plan: null,
        checkedAt: min(8),
        error: "Not signed in. Run `grok login` or sign in from Armada.",
      },
      usage: null,
    },
    {
      id: "acc-local-ollama",
      provider: "local",
      name: "Ollama",
      color: "#4FC3F7",
      authKind: "default",
      isSystem: false,
      configDir: "~/.local/share/armada/profiles/acc-local-ollama",
      createdAt: min(60 * 24 * 2),
      status: { loggedIn: true, label: "Ollama · 4 models", email: null, plan: null, checkedAt: min(3), error: null },
      usage: null,
      local: { kind: "ollama", baseUrl: "http://127.0.0.1:11434" },
    },
    {
      id: "system-custom",
      provider: "custom",
      name: "Default",
      color: "#A78BFA",
      authKind: "default",
      isSystem: true,
      configDir: null,
      createdAt: min(60 * 24 * 30),
      status: { loggedIn: true, label: "No sign-in needed", email: null, plan: null, checkedAt: min(1), error: null },
      usage: null,
    },
  ];
}

export function seedProviders(): ProviderInfo[] {
  return [
    {
      provider: "claude",
      displayName: "Claude",
      cliName: "claude",
      installed: true,
      managed: true,
      managedVersion: "0.98.0",
      testedVersion: "0.98.0",
      latestVersion: "0.98.0",
      updateAvailable: false,
      updatesCheckedAt: Date.now() - 2.5 * 3600_000,
      version: "2.1.310",
      path: "~/.local/share/armada/tools/node_modules/.bin/claude-agent-acp",
      adapterRequired: true,
      adapterInstalled: true,
      nodeAvailable: true,
      installCommand: "npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp",
      docsUrl: "https://docs.claude.com/en/docs/claude-code",
    },
    {
      provider: "codex",
      displayName: "ChatGPT (Codex)",
      cliName: "codex",
      installed: true,
      managed: true,
      managedVersion: "0.165.0",
      testedVersion: "0.165.0",
      latestVersion: "0.166.0",
      updateAvailable: true,
      updatesCheckedAt: Date.now() - 2.5 * 3600_000,
      version: "0.165.0",
      path: "~/.local/share/armada/tools/node_modules/.bin/codex",
      adapterRequired: false,
      adapterInstalled: false,
      nodeAvailable: true,
      installCommand: "npm install -g @openai/codex",
      docsUrl: "https://developers.openai.com/codex/cli",
    },
    {
      provider: "grok",
      displayName: "Grok",
      cliName: "grok",
      installed: true,
      managed: false,
      managedVersion: null,
      testedVersion: "0.4.1",
      latestVersion: "0.4.2",
      updateAvailable: false,
      updatesCheckedAt: Date.now() - 2.5 * 3600_000,
      version: "0.4.1",
      path: "/usr/local/bin/grok",
      adapterRequired: false,
      adapterInstalled: false,
      nodeAvailable: true,
      installCommand: "npm install -g @xai-org/grok-build",
      docsUrl: "https://x.ai",
    },
  ];
}

export function seedSettings(onboarded: boolean): Settings {
  return {
    onboarded,
    // Review convenience: ?theme=titanium|carbon.
    theme: ((): Settings["theme"] => {
      try {
        const t = new URLSearchParams(location.search).get("theme");
        return t === "titanium" || t === "carbon" ? t : "gunmetal";
      } catch {
        return "gunmetal";
      }
    })(),
    interfaceScale: 100,
    sounds: {
      enabled: true,
      volume: 0.6,
      onPermission: true,
      onDone: true,
      onError: true,
      customPermission: null,
      customDone: null,
      customError: null,
      chimeWhenWatching: true,
    },
    notifications: {
      enabled: true,
      onPermission: true,
      onDone: true,
      onError: true,
      smartMute: true,
    },
    quietHours: { enabled: false, start: "22:00", end: "08:00" },
    closeToTray: true,
    autoResume: false,
    autoUpdateTools: true,
    defaultWorktree: true,
    launchAtLogin: false,
    globalHotkey: "CmdOrCtrl+Shift+Space",
    escalateAfterMins: 5,
    ntfyUrl: null,
    ntfyDetail: "minimal",
    recentProjects: [
      "/home/sam/Projects/atlas-api",
      "/home/sam/Projects/storefront",
      "/home/sam/Projects/console-web",
      "/home/sam/Projects/infra",
    ],
    autoCheckUpdates: true,
    failover: "ask",
    defaultPermissionMode: "auto",
    busySend: "ask",
    helperDefaults: { provider: null, accountId: null, customAgentId: null, model: null },
    remote: { enabled: false, lan: false, port: 47821, tailscale: false, lanAddress: null },
    voice: { inputDevice: null, model: "base.en", language: "auto", autoSend: false },
    voiceAssistant: {
      enabled: true,
      accountId: null,
      voice: "marin",
      model: "gpt-realtime",
      maxSessionMins: 10,
      silenceTimeoutSecs: 60,
      headphones: false,
    },
    customAgents: [
      {
        id: "ca-gemini",
        name: "Gemini CLI",
        command: "gemini",
        args: ["--acp"],
        env: [],
        color: "#4E8EF7",
        enabled: true,
      },
      {
        id: "ca-goose",
        name: "Goose",
        command: "goose",
        args: ["acp"],
        env: [{ name: "GOOSE_PROVIDER", value: "anthropic" }],
        color: "#F472B6",
        enabled: false,
      },
    ],
    templates: [
      {
        id: "tpl-tests",
        name: "Write tests",
        body: "Write thorough tests for {{target}}. Cover edge cases and failure paths, follow the existing test style, and make sure the whole suite passes.",
      },
      {
        id: "tpl-review",
        name: "Review my changes",
        body: "Review the uncommitted changes in this repo like a senior engineer. Focus on {{focus}}. List concrete issues with file and line, most important first.",
      },
      {
        id: "tpl-explain",
        name: "Explain this codebase",
        body: "Give me a guided tour of this codebase: architecture, the main modules and how they talk to each other, and where I should start reading.",
      },
    ],
    mcpServers: [
      {
        id: "mcp-github",
        name: "GitHub",
        enabled: true,
        transport: "http",
        command: "",
        args: [],
        env: [],
        url: "https://api.githubcopilot.com/mcp/",
        headers: [{ name: "Authorization", value: "Bearer •••• demo token ••••" }],
      },
      {
        id: "mcp-postgres",
        name: "Postgres (dev)",
        enabled: true,
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/atlas_dev"],
        env: [],
        url: "",
        headers: [],
      },
      {
        id: "mcp-sentry",
        name: "Sentry",
        enabled: false,
        transport: "stdio",
        command: "uvx",
        args: ["mcp-server-sentry"],
        env: [{ name: "SENTRY_AUTH_TOKEN", value: "sntrys_demo_token" }],
        url: "",
        headers: [],
      },
    ],
  };
}

// ---------------------------------------------------------------- config options

export function configFor(provider: Provider, model?: string | null): ConfigOption[] {
  if (provider === "custom") return [];
  if (provider === "local") {
    return [
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: model ?? "qwen3-coder:30b",
        options: [
          { value: "qwen3-coder:30b", name: "qwen3-coder:30b", description: "30.5B · Q4_K_M · 256k context" },
          { value: "gpt-oss:20b", name: "gpt-oss:20b", description: "20.9B · MXFP4 · 128k context" },
          { value: "devstral:24b", name: "devstral:24b", description: "23.6B · Q4_K_M · 128k context" },
          { value: "llama3.2:3b", name: "llama3.2:3b", description: "3.2B · Q4_K_M · 128k context" },
        ],
      },
      {
        id: "approval",
        name: "Approvals",
        category: "mode",
        currentValue: "on-request",
        options: [
          { value: "untrusted", name: "Untrusted", description: "Ask for anything non-trivial" },
          { value: "on-request", name: "On request", description: "Model decides when to ask" },
          { value: "never", name: "Full auto", description: "Never ask" },
        ],
      },
    ];
  }
  if (provider === "claude") {
    return [
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: model ?? "opus",
        options: [
          { value: "opus", name: "Opus", description: "Most capable for complex work" },
          { value: "sonnet", name: "Sonnet", description: "Fast and smart for everyday tasks" },
          { value: "haiku", name: "Haiku", description: "Fastest for quick answers" },
        ],
      },
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        currentValue: "default",
        options: [
          { value: "default", name: "Ask before edits", description: "Approve every edit and command" },
          { value: "acceptEdits", name: "Accept edits", description: "Auto-approve file edits" },
          { value: "plan", name: "Plan mode", description: "Research and plan, no changes" },
          { value: "bypassPermissions", name: "Bypass permissions", description: "Never ask (careful)" },
        ],
      },
    ];
  }
  if (provider === "codex") {
    return [
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: model ?? "gpt-5.1-codex",
        options: [
          { value: "gpt-5.1-codex", name: "gpt-5.1-codex", description: "Optimized for agentic coding" },
          { value: "gpt-5.1-codex-mini", name: "gpt-5.1-codex-mini", description: "Cheaper, faster" },
          { value: "gpt-5.1", name: "gpt-5.1", description: "General reasoning" },
        ],
      },
      {
        id: "effort",
        name: "Reasoning",
        category: "thought_level",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low", description: null },
          { value: "medium", name: "Medium", description: null },
          { value: "high", name: "High", description: null },
        ],
      },
      {
        id: "approval",
        name: "Approvals",
        category: "mode",
        currentValue: "on-request",
        options: [
          { value: "untrusted", name: "Untrusted", description: "Ask for anything non-trivial" },
          { value: "on-request", name: "On request", description: "Model decides when to ask" },
          { value: "never", name: "Full auto", description: "Never ask" },
        ],
      },
    ];
  }
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: model ?? "grok-code-fast-1",
      options: [
        { value: "grok-code-fast-1", name: "grok-code-fast-1", description: "Fast agentic coding" },
        { value: "grok-4", name: "grok-4", description: "Deep reasoning" },
      ],
    },
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "ask",
      options: [
        { value: "ask", name: "Ask", description: "Approve tools" },
        { value: "auto", name: "Auto", description: "Run tools automatically" },
      ],
    },
  ];
}

// ---------------------------------------------------------------- agents

interface AgentSeed {
  id: string;
  title: string;
  provider: Provider;
  accountId: string;
  project: string;
  branch: string | null;
  status: Agent["status"];
  minsAgo: number;
  cost: number;
  tokens: number;
  context: [number, number] | null;
  unread?: boolean;
  archived?: boolean;
  groupId?: string;
  lastMessage: string | null;
  pending?: number;
  rateLimited?: boolean;
  scheduleId?: string;
  customAgentId?: string;
  queue?: QueuedPrompt[];
  queuePaused?: boolean;
  parentId?: string;
  helperSync?: Agent["helperSync"];
}

function makeAgent(s: AgentSeed): Agent {
  const projectPath = `/home/sam/Projects/${s.project}`;
  const worktree = s.branch !== null;
  return {
    id: s.id,
    title: s.title,
    provider: s.provider,
    accountId: s.accountId,
    projectPath,
    cwd: worktree ? `/home/sam/.armada/worktrees/${s.project}/${s.id}` : projectPath,
    worktree,
    branch: s.branch,
    baseBranch: worktree ? "main" : null,
    baseCommit: worktree ? "4f1c2e9a7b" : null,
    sessionId: `${s.provider === "codex" ? "thr" : "ses"}_${s.id.replace(/-/g, "")}9c41f2`,
    status: s.status,
    running: ["working", "needs_permission", "idle", "starting"].includes(s.status),
    groupId: s.groupId ?? null,
    createdAt: min(s.minsAgo + 30),
    updatedAt: min(s.minsAgo),
    lastActivityAt: min(s.minsAgo),
    costUsd: s.cost,
    tokensUsed: s.tokens,
    contextUsed: s.context ? s.context[0] : null,
    contextSize: s.context ? s.context[1] : null,
    unread: s.unread ?? false,
    archived: s.archived ?? false,
    lastMessage: s.lastMessage,
    pendingPermissions: s.pending ?? 0,
    configOptions: configFor(s.provider),
    steerable: s.provider === "claude" || s.provider === "codex",
    availableCommands: commandsFor(s.provider),
    rateLimited: s.rateLimited ?? false,
    scheduleId: s.scheduleId ?? null,
    customAgentId: s.customAgentId ?? null,
    queuedPrompts: s.queue?.length ?? 0,
    queue: s.queue ?? [],
    queuePaused: s.queuePaused ?? false,
    acknowledgedAt: null,
    needsBriefing: false,
    configChoices: {},
    permissionMode: "auto",
    parentId: s.parentId ?? null,
    helperSync: s.helperSync ?? null,
  };
}

export function seedAgents(): Agent[] {
  return [
    makeAgent({
      id: "a-token",
      title: "Fix token refresh race",
      provider: "claude",
      accountId: "acc-claude-work",
      project: "atlas-api",
      branch: "armada/fix-token-refresh",
      status: "working",
      minsAgo: 0.2,
      cost: 1.84,
      tokens: 412_300,
      context: [82_400, 200_000],
      lastMessage: "Running the auth suite to confirm the fix…",
      queue: [
        { id: "q-1", text: "After that, also cover the logout-on-refresh-failure path with a test.", attachments: 0 },
        { id: "q-2", text: "Then summarize the change as a PR description.", attachments: 0 },
      ],
    }),
    makeAgent({
      id: "a-token-h1",
      title: "Helper: logout-on-refresh-failure test",
      provider: "claude",
      accountId: "acc-claude-work",
      project: "atlas-api",
      branch: "armada/fix-token-refresh-h1",
      status: "working",
      minsAgo: 0.4,
      cost: 0.21,
      tokens: 48_200,
      context: [18_400, 200_000],
      lastMessage: "Writing the failing test first…",
      parentId: "a-token",
      helperSync: { state: "inSync", lastSyncAt: Date.now() - 40_000, detail: null, files: 2 },
    }),
    makeAgent({
      id: "a-token-h2",
      title: "Helper: update the session docs",
      provider: "claude",
      accountId: "acc-claude-work",
      project: "atlas-api",
      branch: "armada/fix-token-refresh-h2",
      status: "working",
      minsAgo: 0.6,
      cost: 0.09,
      tokens: 21_500,
      context: [9_200, 200_000],
      lastMessage: "Both of us edited docs/auth.md; I need a hand merging.",
      parentId: "a-token",
      helperSync: {
        state: "conflict",
        lastSyncAt: Date.now() - 5 * 60_000,
        detail: "Conflicting edits in docs/auth.md",
        files: 3,
      },
    }),
    makeAgent({
      id: "a-billing",
      title: "Migrate billing to PaymentIntents",
      provider: "codex",
      accountId: "acc-codex-sys",
      project: "atlas-api",
      branch: "armada/billing-payment-intents",
      status: "needs_permission",
      minsAgo: 1.5,
      cost: 0.97,
      tokens: 288_900,
      context: [61_000, 272_000],
      unread: true,
      pending: 1,
      lastMessage: "The schema needs a new paymentIntentId column, so I need to run a migration.",
    }),
    makeAgent({
      id: "a-ratelimit",
      title: "Add rate limiting to public API",
      provider: "claude",
      accountId: "acc-claude-sys",
      project: "storefront",
      branch: "armada/rate-limit",
      status: "needs_permission",
      minsAgo: 3,
      cost: 0.41,
      tokens: 96_200,
      context: [38_100, 200_000],
      pending: 1,
      lastMessage: "I'll add a sliding-window limiter as Express middleware.",
    }),
    makeAgent({
      id: "a-question",
      title: "Set up the orders data layer",
      provider: "claude",
      accountId: "acc-claude-sys",
      project: "storefront",
      branch: "armada/orders-data-layer",
      status: "needs_permission",
      minsAgo: 2,
      cost: 0.18,
      tokens: 41_300,
      context: [22_400, 200_000],
      pending: 1,
      lastMessage: "Before I scaffold it, I have a couple of questions.",
    }),
    makeAgent({
      id: "a-research",
      title: "Research: vector DB options",
      provider: "grok",
      accountId: "acc-grok-sys",
      project: "console-web",
      branch: null,
      status: "working",
      minsAgo: 0.5,
      cost: 0.22,
      tokens: 141_000,
      context: [44_000, 256_000],
      lastMessage: "Comparing pgvector against Qdrant for our query volume…",
    }),
    makeAgent({
      id: "a-e2e",
      title: "Write e2e tests for checkout",
      provider: "claude",
      accountId: "acc-claude-sys",
      project: "storefront",
      branch: "armada/e2e-checkout",
      status: "idle",
      minsAgo: 12,
      cost: 2.63,
      tokens: 655_000,
      context: [131_000, 200_000],
      unread: true,
      lastMessage: "All 14 checkout specs pass. Summary of what I covered below.",
    }),
    makeAgent({
      id: "a-settings",
      title: "Refactor settings store into slices",
      provider: "codex",
      accountId: "acc-codex-sys",
      project: "console-web",
      branch: "armada/settings-slices",
      status: "error",
      minsAgo: 26,
      cost: 1.12,
      tokens: 301_400,
      context: [210_000, 272_000],
      lastMessage: "Rate limit reached for this account.",
      rateLimited: true,
      queuePaused: true,
      queue: [
        { id: "q-3", text: "Once the slices compile, migrate the billing page to the new hooks.", attachments: 0 },
      ],
    }),
    makeAgent({
      id: "a-react19",
      title: "Upgrade to React 19",
      provider: "claude",
      accountId: "acc-claude-sys",
      project: "console-web",
      branch: "armada/react-19",
      status: "error",
      minsAgo: 7,
      cost: 3.41,
      tokens: 812_000,
      context: [148_000, 200_000],
      unread: true,
      rateLimited: true,
      lastMessage: "Claude usage limit reached for Personal. Resets at 6:00 PM.",
    }),
    makeAgent({
      id: "a-darkmode",
      title: "Dark mode for analytics dashboard",
      provider: "claude",
      accountId: "acc-claude-work",
      project: "console-web",
      branch: "armada/dashboard-dark",
      status: "interrupted",
      minsAgo: 95,
      cost: 0.88,
      tokens: 204_000,
      context: [57_000, 200_000],
      lastMessage: "Updating chart palette tokens for the dark theme…",
    }),
    makeAgent({
      id: "a-deps",
      title: "Bump dependencies & fix breakages",
      provider: "grok",
      accountId: "acc-grok-sys",
      project: "infra",
      branch: "armada/deps-bump",
      status: "stopped",
      minsAgo: 60 * 5,
      cost: 0.31,
      tokens: 88_000,
      context: null,
      lastMessage: "Upgraded 23 packages; 2 type errors left in the CDK stack.",
      scheduleId: "sch-deps",
    }),
    makeAgent({
      id: "a-cmp-claude",
      title: "Debounce the search input",
      provider: "claude",
      accountId: "acc-claude-sys",
      project: "storefront",
      branch: "armada/debounce-claude",
      status: "idle",
      minsAgo: 40,
      cost: 0.18,
      tokens: 41_000,
      context: [19_000, 200_000],
      groupId: "grp-debounce",
      lastMessage: "Added a `useDebouncedValue` hook (250 ms) with a cancel-on-unmount test.",
    }),
    makeAgent({
      id: "a-cmp-codex",
      title: "Debounce the search input",
      provider: "codex",
      accountId: "acc-codex-api",
      project: "storefront",
      branch: "armada/debounce-codex",
      status: "idle",
      minsAgo: 41,
      cost: 0.09,
      tokens: 37_500,
      context: [16_000, 272_000],
      groupId: "grp-debounce",
      lastMessage: "Wrapped the fetch in `lodash.debounce` and memoized it with useMemo.",
    }),
    makeAgent({
      id: "a-cmp-grok",
      title: "Debounce the search input",
      provider: "grok",
      accountId: "acc-grok-sys",
      project: "storefront",
      branch: "armada/debounce-grok",
      status: "idle",
      minsAgo: 42,
      cost: 0.05,
      tokens: 29_000,
      context: [12_000, 256_000],
      groupId: "grp-debounce",
      lastMessage: "Used an AbortController + 300 ms timer so stale requests are cancelled.",
    }),
    makeAgent({
      id: "a-gemini",
      title: "Summarize the v3 changelog",
      provider: "custom",
      customAgentId: "ca-gemini",
      accountId: "system-custom",
      project: "atlas-api",
      branch: null,
      status: "idle",
      minsAgo: 18,
      cost: 0,
      tokens: 58_000,
      context: [21_000, 1_000_000],
      lastMessage: "Drafted release notes for v3.0 grouped by breaking changes, features and fixes.",
    }),
    makeAgent({
      id: "a-sse",
      title: "Spike: SSE vs WebSocket for live feed",
      provider: "claude",
      accountId: "acc-claude-work",
      project: "atlas-api",
      branch: null,
      status: "idle",
      minsAgo: 60 * 26,
      cost: 0.57,
      tokens: 120_000,
      context: [40_000, 200_000],
      archived: true,
      lastMessage: "Recommendation: SSE. Simpler infra, works through our proxies.",
    }),
  ];
}

// ---------------------------------------------------------------- timelines

type ItemInit = TimelineItem extends infer T
  ? T extends TimelineItem
    ? Omit<T, "id" | "agentId" | "seq" | "ts"> & { at?: number }
    : never
  : never;

function build(agentId: string, startMinsAgo: number, items: ItemInit[]): TimelineItem[] {
  const step = (startMinsAgo * 60_000) / Math.max(1, items.length);
  return items.map((it, i) => {
    const { at, ...rest } = it as ItemInit & { at?: number };
    return {
      ...(rest as object),
      id: `${agentId}-i${i + 1}`,
      agentId,
      seq: i + 1,
      ts: at ?? NOW - startMinsAgo * 60_000 + step * i,
    } as TimelineItem;
  });
}

const execOpts = (tool: string): PermissionOption[] => [
  { id: "allow", name: "Allow once", kind: "allow_once" },
  { id: "always", name: `Always allow ${tool}`, kind: "allow_always" },
  { id: "deny", name: "Deny", kind: "reject_once" },
];

const SESSION_OLD = `import { api } from "../http/client";
import { tokenStore } from "./store";

export async function refreshToken(): Promise<string> {
  const refresh = tokenStore.getRefreshToken();
  if (!refresh) throw new AuthError("no refresh token");

  const res = await api.post("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: refresh,
  });
  tokenStore.set(res.access_token, res.refresh_token);
  return res.access_token;
}
`;

const SESSION_NEW = `import { api } from "../http/client";
import { tokenStore } from "./store";

let inflight: Promise<string> | null = null;

/**
 * Single-flight refresh: concurrent callers share one request so a
 * second 401 can't rotate (and invalidate) the token we just received.
 */
export function refreshToken(): Promise<string> {
  inflight ??= doRefresh().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doRefresh(): Promise<string> {
  const refresh = tokenStore.getRefreshToken();
  if (!refresh) throw new AuthError("no refresh token");

  const res = await api.post("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: refresh,
  });
  tokenStore.set(res.access_token, res.refresh_token);
  return res.access_token;
}
`;

const AUTH_TEST_UNIFIED = `--- a/test/auth.test.ts
+++ b/test/auth.test.ts
@@ -1,6 +1,7 @@
 import { describe, expect, it, vi } from "vitest";
 import { refreshToken } from "../src/auth/session";
 import { api } from "../src/http/client";
+import { tokenStore } from "../src/auth/store";

 describe("refreshToken", () => {
   it("stores the new token pair", async () => {
@@ -14,4 +15,18 @@ describe("refreshToken", () => {
     expect(tokenStore.get()).toBe("new-access");
   });
+
+  it("shares one request between concurrent callers", async () => {
+    const post = vi.spyOn(api, "post").mockResolvedValue({
+      access_token: "a2",
+      refresh_token: "r2",
+    });
+
+    const [a, b] = await Promise.all([refreshToken(), refreshToken()]);
+
+    expect(post).toHaveBeenCalledTimes(1);
+    expect(a).toBe("a2");
+    expect(b).toBe("a2");
+  });
 });
`;

const STRIPE_UNIFIED = `@@ -18,22 +18,27 @@ export class BillingService {
   async charge(customer: Customer, amountCents: number, memo: string) {
-    const charge = await this.stripe.charges.create({
-      amount: amountCents,
-      currency: "usd",
-      customer: customer.stripeId,
-      description: memo,
-    });
-    await this.db.payment.create({
-      data: { customerId: customer.id, chargeId: charge.id, amountCents },
-    });
-    return charge.status === "succeeded";
+    const intent = await this.stripe.paymentIntents.create({
+      amount: amountCents,
+      currency: "usd",
+      customer: customer.stripeId,
+      description: memo,
+      confirm: true,
+      off_session: true,
+      payment_method: customer.defaultPaymentMethod,
+    });
+    await this.db.payment.create({
+      data: {
+        customerId: customer.id,
+        paymentIntentId: intent.id,
+        amountCents,
+      },
+    });
+    return intent.status === "succeeded";
   }
`;

const PRISMA_UNIFIED = `diff --git a/prisma/schema.prisma b/prisma/schema.prisma
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -41,9 +41,10 @@ model Payment {
   id              String   @id @default(cuid())
   customerId      String
-  chargeId        String   @unique
+  chargeId        String?  @unique
+  paymentIntentId String?  @unique
   amountCents     Int
   createdAt       DateTime @default(now())
   customer        Customer @relation(fields: [customerId], references: [id])
 }
`;

const RATE_LIMIT_NEW = `import type { NextFunction, Request, Response } from "express";
import { redis } from "../lib/redis";

const WINDOW_MS = 60_000;
const LIMIT = 120;

/** Sliding-window limiter keyed by API key (falls back to IP). */
export async function rateLimit(req: Request, res: Response, next: NextFunction) {
  const key = \`rl:\${req.header("x-api-key") ?? req.ip}\`;
  const now = Date.now();

  const [, , count] = await redis
    .multi()
    .zremrangebyscore(key, 0, now - WINDOW_MS)
    .zadd(key, now, \`\${now}-\${Math.random()}\`)
    .zcard(key)
    .pexpire(key, WINDOW_MS)
    .exec();

  res.setHeader("RateLimit-Limit", LIMIT);
  res.setHeader("RateLimit-Remaining", Math.max(0, LIMIT - Number(count)));

  if (Number(count) > LIMIT) {
    return res.status(429).json({ error: "rate_limited", retryAfterMs: WINDOW_MS });
  }
  next();
}
`;

/** Review convenience: ?question=mcp seeds an MCP-style form instead of Claude's AskUserQuestion. */
function questionVariant(): string | null {
  try {
    return new URLSearchParams(location.search).get("question");
  } catch {
    return null;
  }
}

export function seedItems(): Record<string, TimelineItem[]> {
  const out: Record<string, TimelineItem[]> = {};

  out["a-token-h1"] = build("a-token-h1", 3, [
    {
      kind: "user_message",
      text: "While you fix the race, write a test for the logout-on-refresh-failure path.",
    },
    {
      kind: "agent_message",
      text: "On it. I'll start from your current `session.ts` and write the failing test first.",
    },
  ]);
  out["a-token-h2"] = build("a-token-h2", 5, [
    { kind: "user_message", text: "Update docs/auth.md to describe the single-flight refresh." },
    {
      kind: "agent_message",
      text: "I rewrote the **Token refresh** section of `docs/auth.md`. The main agent also touched that file, so the merge stopped on a conflict.",
    },
  ]);

  out["a-token"] = build("a-token", 9, [
    {
      kind: "user_message",
      text: "The token refresh in `src/auth/session.ts` races when two requests 401 at the same time: both trigger a refresh and the second one invalidates the first token. Fix it and add a regression test.",
    },
    {
      kind: "thought",
      text: "Two concurrent 401s each call `refreshToken()`. The refresh endpoint rotates refresh tokens, so the second call uses an already-rotated token and the server revokes the family.\n\nFix: single-flight. Keep one in-flight promise; concurrent callers await it. Need to check where refresh is invoked, probably the fetch interceptor in `client.ts`.",
    },
    {
      kind: "tool_call",
      toolCallId: "tc-1",
      title: "Search for `refreshToken(`",
      toolKind: "search",
      status: "completed",
      locations: ["src/auth/session.ts", "src/http/client.ts"],
      diffs: [],
      output:
        'src/auth/session.ts:4:export async function refreshToken(): Promise<string> {\nsrc/http/client.ts:88:      const token = await refreshToken();\nsrc/http/client.ts:131:    await refreshToken();\ntest/auth.test.ts:2:import { refreshToken } from "../src/auth/session";',
      command: null,
    },
    {
      kind: "tool_call",
      toolCallId: "sa-1",
      title: "Explore auth call sites",
      toolKind: "other",
      status: "completed",
      locations: [],
      diffs: [],
      output: "Found 3 refresh call sites; only the response interceptor retries concurrently.",
      command: null,
      subagent: {
        kind: "Explore",
        description: "Find every caller of refreshToken() and how retries are queued",
        prompt:
          "Search the codebase for every call to refreshToken() and the HTTP interceptor that retries 401s. Report file:line for each call site and whether concurrent requests can trigger parallel refreshes. Do not edit files.",
      },
    },
    {
      kind: "tool_call",
      toolCallId: "sa-1-a",
      title: "Search for `refreshToken`",
      toolKind: "search",
      status: "completed",
      locations: ["src/auth/session.ts", "src/http/client.ts"],
      diffs: [],
      output: "3 matches in 2 files",
      command: null,
      parentToolCallId: "sa-1",
    },
    {
      kind: "tool_call",
      toolCallId: "sa-1-b",
      title: "Read src/http/client.ts",
      toolKind: "read",
      status: "completed",
      locations: ["src/http/client.ts"],
      diffs: [],
      output: "",
      command: null,
      parentToolCallId: "sa-1",
    },
    {
      kind: "tool_call",
      toolCallId: "sa-1-c",
      title: "Read src/auth/store.ts",
      toolKind: "read",
      status: "completed",
      locations: ["src/auth/store.ts"],
      diffs: [],
      output: "",
      command: null,
      parentToolCallId: "sa-1",
    },
    {
      kind: "tool_call",
      toolCallId: "tc-2",
      title: "Read src/http/client.ts",
      toolKind: "read",
      status: "completed",
      locations: ["src/http/client.ts"],
      diffs: [],
      output: "",
      command: null,
    },
    {
      kind: "agent_message",
      text: "Found it. The response interceptor in `client.ts` calls `refreshToken()` independently for **every** failed request, so two parallel 401s start two refreshes. Because the server rotates refresh tokens, the second refresh revokes the first.\n\nI'll make the refresh **single-flight**: the first caller creates the promise and everyone else awaits the same one.",
    },
    {
      kind: "plan",
      entries: [
        { content: "Make refreshToken() single-flight", status: "completed", priority: "high" },
        { content: "Retry queued requests with the refreshed token", status: "completed", priority: "medium" },
        { content: "Add a regression test for concurrent 401s", status: "completed", priority: "high" },
        { content: "Run the auth test suite", status: "in_progress", priority: "medium" },
        { content: "Summarize the change for review", status: "pending", priority: "low" },
      ],
    },
    {
      kind: "tool_call",
      toolCallId: "tc-3",
      title: "Edit src/auth/session.ts",
      toolKind: "edit",
      status: "completed",
      locations: ["src/auth/session.ts"],
      diffs: [{ path: "src/auth/session.ts", oldText: SESSION_OLD, newText: SESSION_NEW, unified: null }],
      output: "",
      command: null,
    },
    {
      kind: "tool_call",
      toolCallId: "tc-4",
      title: "Edit test/auth.test.ts",
      toolKind: "edit",
      status: "completed",
      locations: ["test/auth.test.ts"],
      diffs: [{ path: "test/auth.test.ts", oldText: null, newText: null, unified: AUTH_TEST_UNIFIED }],
      output: "",
      command: null,
    },
    {
      kind: "agent_message",
      text: "The dev server for this branch is running at http://127.0.0.1:4723 (4721 was already taken by another worktree). Open the Preview to see the refresh flow.",
    },
    {
      kind: "tool_call",
      toolCallId: "tc-5",
      title: "Run npm test -- auth",
      toolKind: "execute",
      status: "in_progress",
      locations: [],
      diffs: [],
      output:
        "\n> atlas-api@3.4.0 test\n> vitest run auth\n\n RUN  v3.2.4 /home/sam/.armada/worktrees/atlas-api/a-token\n\n",
      command: "npm test -- auth",
    },
  ]);

  out["a-billing"] = build("a-billing", 14, [
    {
      kind: "user_message",
      text: "Migrate our billing module from the legacy Stripe Charges API to PaymentIntents. Keep the webhook handlers backwards compatible for old charges.",
    },
    {
      kind: "thought",
      text: "**Inventorying charge usage**\n\nI'll grep for `stripe.charges`, update the service layer first, then the Prisma schema, and keep `charge.*` webhook events flowing to the legacy handler.",
    },
    {
      kind: "tool_call",
      toolCallId: "cx-1",
      title: 'rg -n "stripe.charges" src',
      toolKind: "execute",
      status: "completed",
      locations: [],
      diffs: [],
      output:
        'src/billing/stripe.ts:19:    const charge = await this.stripe.charges.create({\nsrc/billing/refunds.ts:33:    await this.stripe.charges.retrieve(chargeId);\nsrc/webhooks/stripe.ts:57:      case "charge.succeeded":',
      command: 'rg -n "stripe.charges" src',
    },
    {
      kind: "tool_call",
      toolCallId: "cx-2",
      title: "Edit src/billing/stripe.ts",
      toolKind: "edit",
      status: "completed",
      locations: ["src/billing/stripe.ts"],
      diffs: [{ path: "src/billing/stripe.ts", oldText: null, newText: null, unified: STRIPE_UNIFIED }],
      output: "",
      command: null,
    },
    {
      kind: "tool_call",
      toolCallId: "cx-3",
      title: "Edit prisma/schema.prisma",
      toolKind: "edit",
      status: "completed",
      locations: ["prisma/schema.prisma"],
      diffs: [{ path: "prisma/schema.prisma", oldText: null, newText: null, unified: PRISMA_UNIFIED }],
      output: "",
      command: null,
    },
    {
      kind: "agent_message",
      text: "Service layer now creates **PaymentIntents** with `confirm: true` and `off_session: true`, and webhook handling still accepts `charge.*` events for historical payments.\n\nThe schema needs a new `paymentIntentId` column (and `chargeId` becomes optional), so I need to generate and apply a migration against your local dev database.",
    },
    {
      kind: "permission",
      requestId: "perm-billing-1",
      title: "Run pnpm prisma migrate dev --name billing_payment_intents",
      toolKind: "execute",
      command: "pnpm prisma migrate dev --name billing_payment_intents",
      diffs: [],
      options: execOpts("`pnpm prisma`"),
      resolution: null,
      at: NOW - 90_000,
    },
  ]);

  out["a-ratelimit"] = build("a-ratelimit", 6, [
    {
      kind: "user_message",
      text: "Add rate limiting to the public API. 120 req/min per API key, fall back to IP. Use the Redis we already have.",
    },
    {
      kind: "tool_call",
      toolCallId: "rl-1",
      title: "Read src/server.ts",
      toolKind: "read",
      status: "completed",
      locations: ["src/server.ts"],
      diffs: [],
      output: "",
      command: null,
    },
    {
      kind: "tool_call",
      toolCallId: "rl-2",
      title: "Read src/lib/redis.ts",
      toolKind: "read",
      status: "completed",
      locations: ["src/lib/redis.ts"],
      diffs: [],
      output: "",
      command: null,
    },
    {
      kind: "agent_message",
      text: "I'll add a **sliding-window** limiter as Express middleware backed by a Redis sorted set. It sets the standard `RateLimit-*` headers and returns `429` with a `retryAfterMs` hint.",
    },
    {
      kind: "permission",
      requestId: "perm-rl-1",
      title: "Create src/middleware/rateLimit.ts",
      toolKind: "edit",
      command: null,
      diffs: [{ path: "src/middleware/rateLimit.ts", oldText: null, newText: RATE_LIMIT_NEW, unified: null }],
      options: [
        { id: "yes", name: "Yes", kind: "allow_once" },
        { id: "yes-all", name: "Yes, allow all edits this session", kind: "allow_always" },
        { id: "no", name: "No, and tell Claude what to do", kind: "reject_once" },
      ],
      resolution: null,
      at: NOW - 3 * 60_000,
    },
  ]);

  out["a-question"] = build("a-question", 5, [
    {
      kind: "user_message",
      text: "Add a persistent store for orders. Pick whatever fits; ask me if it matters.",
    },
    {
      kind: "tool_call",
      toolCallId: "q-1",
      title: "Read package.json",
      toolKind: "read",
      status: "completed",
      locations: ["package.json"],
      diffs: [],
      output: "",
      command: null,
    },
    {
      kind: "question",
      requestId: "ask-orders-0",
      message: "Which database should the orders service use?",
      fields: [
        {
          id: "question_0",
          title: "Database",
          description: "Which database should the orders service use?",
          kind: "single",
          options: [
            {
              value: "postgres",
              label: "Postgres",
              description: "Relational, transactions, what the rest of the stack uses.",
            },
            { value: "sqlite", label: "SQLite", description: "Zero setup and a single file; fine for a prototype." },
            {
              value: "dynamodb",
              label: "DynamoDB",
              description: "Managed key-value, scales without ops, awkward for reports.",
            },
          ],
          required: true,
        },
        { id: "question_0_custom", kind: "text", otherFor: "question_0" },
      ],
      resolution: "answered",
      answers: { question_0: "postgres" },
      at: NOW - 4 * 60_000,
    },
    {
      kind: "agent_message",
      text: "Postgres it is. I'll check what the migrations setup looks like and then scaffold the layer.",
    },
    ...(questionVariant() === "mcp"
      ? [
          {
            kind: "question" as const,
            requestId: "ask-github-form",
            message: "Create a GitHub issue for the migration work?",
            source: "github",
            fields: [
              { id: "title", title: "Title", description: "Issue title", kind: "text" as const, required: true },
              {
                id: "token",
                title: "Token",
                description: "Personal access token",
                kind: "text" as const,
                secret: true,
              },
              { id: "milestone", title: "Milestone", kind: "number" as const },
              { id: "assign", title: "Assign to me", kind: "boolean" as const },
              {
                id: "label",
                title: "Label",
                kind: "single" as const,
                options: [
                  { value: "bug", label: "bug" },
                  { value: "chore", label: "chore" },
                  { value: "feature", label: "feature" },
                ],
              },
            ],
            resolution: null,
          },
        ]
      : [
          {
            kind: "question" as const,
            requestId: "ask-orders-1",
            message: "I need two decisions before I scaffold the orders layer.",
            fields: [
              {
                id: "question_0",
                title: "ORM",
                description: "Which data-access approach should I use?",
                kind: "single" as const,
                options: [
                  {
                    value: "prisma",
                    label: "Prisma",
                    description: "Schema-first with generated types; already used in atlas-api.",
                  },
                  {
                    value: "drizzle",
                    label: "Drizzle",
                    description: "Thin, SQL-like and fully typed; no codegen step.",
                  },
                  { value: "raw", label: "Raw SQL", description: "Hand-written queries through the pg driver." },
                ],
              },
              { id: "question_0_custom", kind: "text" as const, otherFor: "question_0" },
              {
                id: "question_1",
                title: "Extras",
                description: "Which extras should I set up while I'm at it?",
                kind: "multi" as const,
                options: [
                  { value: "migrations", label: "Migrations", description: "Versioned schema changes run in CI." },
                  { value: "seed", label: "Seed script", description: "Fixture orders for local development." },
                  { value: "tests", label: "Integration tests", description: "Run against a throwaway container." },
                  { value: "pool", label: "Connection pooling", description: "PgBouncer-style pooling settings." },
                ],
              },
              { id: "question_1_custom", kind: "text" as const, otherFor: "question_1" },
            ],
            resolution: null,
          },
        ]),
  ]);

  out["a-research"] = build("a-research", 4, [
    {
      kind: "user_message",
      text: "We need semantic search over ~4M support tickets. Compare pgvector, Qdrant and Turbopuffer for cost, latency and ops burden. Give me a recommendation.",
    },
    {
      kind: "thought",
      text: "Key axes: p95 latency at 4M × 1536-dim, filtered search support, hosting cost, and whether we can stay on Postgres. Start with current benchmarks.",
    },
    {
      kind: "tool_call",
      toolCallId: "gk-1",
      title: "Fetch github.com/pgvector/pgvector#hnsw",
      toolKind: "fetch",
      status: "completed",
      locations: [],
      diffs: [],
      output: "200 OK · 48 KB · HNSW index options, iterative scans for filtered queries (0.8+)",
      command: null,
    },
    {
      kind: "tool_call",
      toolCallId: "gk-2",
      title: "Fetch qdrant.tech/benchmarks",
      toolKind: "fetch",
      status: "completed",
      locations: [],
      diffs: [],
      output: "200 OK · 112 KB · single-node benchmarks, filtered search results",
      command: null,
    },
    {
      kind: "agent_message",
      text: "Early read: at 4M vectors **pgvector with HNSW** is viable on a single `r6g.2xlarge`, and keeps everything in Postgres. Qdrant wins on heavily filtered queries. Checking pricing next.\n\n![p95 latency by index size](https://bench.example.com/vector/p95.png?n=4m)",
    },
  ]);

  out["a-e2e"] = build("a-e2e", 34, [
    {
      kind: "user_message",
      text: "Write Playwright e2e tests for the checkout flow: guest checkout, saved cards, coupon codes, and the 3DS challenge path.",
    },
    {
      kind: "tool_call",
      toolCallId: "e-1",
      title: "Read playwright.config.ts",
      toolKind: "read",
      status: "completed",
      locations: ["playwright.config.ts"],
      diffs: [],
      output: "",
      command: null,
    },
    {
      kind: "tool_call",
      toolCallId: "e-2",
      title: 'Search for `data-testid="checkout`',
      toolKind: "search",
      status: "completed",
      locations: ["src/checkout/CheckoutForm.tsx", "src/checkout/PaymentStep.tsx"],
      diffs: [],
      output: "src/checkout/CheckoutForm.tsx: 9 matches\nsrc/checkout/PaymentStep.tsx: 6 matches",
      command: null,
    },
    {
      kind: "permission",
      requestId: "perm-e2e-0",
      title: "Run npx playwright install chromium",
      toolKind: "execute",
      command: "npx playwright install chromium",
      diffs: [],
      options: execOpts("`npx playwright`"),
      resolution: "allow",
    },
    {
      kind: "tool_call",
      toolCallId: "e-3",
      title: "Create e2e/checkout.spec.ts",
      toolKind: "edit",
      status: "completed",
      locations: ["e2e/checkout.spec.ts"],
      diffs: [
        {
          path: "e2e/checkout.spec.ts",
          oldText: null,
          newText:
            'import { expect, test } from "@playwright/test";\nimport { fillCard, seedCart } from "./helpers";\n\ntest.describe("checkout", () => {\n  test("guest can check out with a card", async ({ page }) => {\n    await seedCart(page, ["sku_tee_black_m"]);\n    await page.goto("/checkout");\n    await page.getByLabel("Email").fill("guest@example.com");\n    await fillCard(page, "4242424242424242");\n    await page.getByRole("button", { name: "Pay" }).click();\n    await expect(page.getByText("Order confirmed")).toBeVisible();\n  });\n\n  test("3DS challenge completes", async ({ page }) => {\n    await seedCart(page, ["sku_hoodie_grey_l"]);\n    await page.goto("/checkout");\n    await fillCard(page, "4000002760003184");\n    await page.getByRole("button", { name: "Pay" }).click();\n    const frame = page.frameLocator("iframe[name^=__privateStripeFrame]");\n    await frame.getByRole("button", { name: "Complete" }).click();\n    await expect(page.getByText("Order confirmed")).toBeVisible();\n  });\n});\n',
          unified: null,
        },
      ],
      output: "",
      command: null,
    },
    {
      kind: "tool_call",
      toolCallId: "e-shot",
      title: "Screenshot /checkout (guest, 3DS)",
      toolKind: "other",
      status: "completed",
      locations: ["e2e/__screenshots__/checkout-guest.png", "e2e/__screenshots__/checkout-3ds.png"],
      diffs: [],
      output: "Saved 2 screenshots to e2e/__screenshots__/",
      command: null,
      images: [mockScreenshot("checkout-guest.png"), mockScreenshot("checkout-3ds.png")],
    },
    // A picture the model put in its reply (an image block), with no text of its own.
    { kind: "agent_message", text: "", images: [mockScreenshot("checkout-receipt.png")] },
    {
      kind: "tool_call",
      toolCallId: "e-4",
      title: "Run npx playwright test e2e/checkout.spec.ts",
      toolKind: "execute",
      status: "completed",
      locations: [],
      diffs: [],
      output:
        "Running 14 tests using 4 workers\n\n  ✓  1 [chromium] › checkout.spec.ts:5:3 › guest can check out with a card (2.1s)\n  ✓  2 [chromium] › checkout.spec.ts:14:3 › 3DS challenge completes (3.4s)\n  ✓  3 [chromium] › checkout.spec.ts:24:3 › saved card is preselected (1.2s)\n  ✓  4 [chromium] › checkout.spec.ts:33:3 › expired coupon shows an error (0.9s)\n  ✓  5 [chromium] › checkout.spec.ts:41:3 › percent coupon updates totals (1.0s)\n  …\n  ✓ 14 [chromium] › checkout.spec.ts:118:3 › declined card can be retried (1.6s)\n\n  14 passed (11.8s)",
      command: "npx playwright test e2e/checkout.spec.ts",
    },
    {
      kind: "agent_message",
      text: "Here's the guest checkout after the fix, captured by the spec run:\n\n![Guest checkout](e2e/__screenshots__/checkout-guest-final.png)\n\nThe 3DS challenge iframe now renders inside the modal instead of a new tab.",
    },
    {
      kind: "agent_message",
      text: 'All **14 checkout specs pass** locally (11.8s on 4 workers).\n\n### Coverage\n\n| Flow | Specs | Notes |\n|---|---|---|\n| Guest checkout | 3 | email validation, address autocomplete |\n| Saved cards | 4 | default card preselected, remove card |\n| Coupons | 4 | percent, fixed, expired, stacked (rejected) |\n| 3DS challenge | 3 | success, failure, abandoned |\n\n### Helpers\n\nI added `e2e/helpers.ts` with `seedCart()` (hits the test-only `/__test/cart` route) and `fillCard()`, which handles the Stripe iframe:\n\n```ts\nexport async function fillCard(page: Page, number: string) {\n  const card = page.frameLocator("iframe[title*=\'card number\']");\n  await card.getByPlaceholder("1234 1234 1234 1234").fill(number);\n  await card.getByPlaceholder("MM / YY").fill("12 / 34");\n  await card.getByPlaceholder("CVC").fill("123");\n}\n```\n\n> The 3DS specs need `STRIPE_TEST_MODE=1`; I added it to `.env.test`.\n\nWant me to wire these into CI as a separate job?',
    },
    {
      kind: "turn_summary",
      durationMs: 6 * 60_000 + 42_000,
      files: ["e2e/checkout.spec.ts", "e2e/helpers.ts", ".env.test"],
      toolCalls: 7,
      commands: 2,
      costUsd: 0.84,
      tokens: 212_400,
    },
  ]);

  out["a-settings"] = build("a-settings", 40, [
    {
      kind: "user_message",
      text: "Split the giant settings store into slices (profile, billing, notifications, integrations). No behavior changes.",
    },
    {
      kind: "tool_call",
      toolCallId: "st-1",
      title: "Read src/store/settings.ts",
      toolKind: "read",
      status: "completed",
      locations: ["src/store/settings.ts"],
      diffs: [],
      output: "",
      command: null,
    },
    {
      kind: "tool_call",
      toolCallId: "st-2",
      title: "Create src/store/settings/profile.ts",
      toolKind: "edit",
      status: "completed",
      locations: ["src/store/settings/profile.ts"],
      diffs: [
        {
          path: "src/store/settings/profile.ts",
          oldText: "",
          newText:
            'import type { StateCreator } from "zustand";\n\nexport interface ProfileSlice {\n  displayName: string;\n  avatarUrl: string | null;\n  setDisplayName: (name: string) => void;\n}\n\nexport const createProfileSlice: StateCreator<ProfileSlice> = (set) => ({\n  displayName: "",\n  avatarUrl: null,\n  setDisplayName: (displayName) => set({ displayName }),\n});\n',
          unified: null,
        },
      ],
      output: "",
      command: null,
    },
    {
      kind: "tool_call",
      toolCallId: "st-3",
      title: "Run pnpm tsc --noEmit",
      toolKind: "execute",
      status: "failed",
      locations: [],
      diffs: [],
      output:
        "src/pages/Billing.tsx(14,27): error TS2339: Property 'billingEmail' does not exist on type 'ProfileSlice'.\nsrc/pages/Integrations.tsx(31,9): error TS2554: Expected 1 arguments, but got 2.\n\nFound 2 errors in 2 files.",
      command: "pnpm tsc --noEmit",
    },
    {
      kind: "notice",
      level: "error",
      text: "Rate limit reached for ChatGPT Pro (Personal). Resets in 2h 14m. Switch accounts or hand off to continue.",
    },
  ]);

  out["a-darkmode"] = build("a-darkmode", 110, [
    {
      kind: "user_message",
      text: "Add a dark theme to the analytics dashboard. Respect prefers-color-scheme, plus a manual toggle in the header.",
    },
    {
      kind: "tool_call",
      toolCallId: "dm-1",
      title: "Edit src/styles/tokens.css",
      toolKind: "edit",
      status: "completed",
      locations: ["src/styles/tokens.css"],
      diffs: [
        {
          path: "src/styles/tokens.css",
          oldText: ":root {\n  --surface: #ffffff;\n  --text: #111827;\n  --grid: #e5e7eb;\n}\n",
          newText:
            ':root {\n  --surface: #ffffff;\n  --text: #111827;\n  --grid: #e5e7eb;\n}\n\n@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n    --surface: #0f1115;\n    --text: #e5e7eb;\n    --grid: #1f2937;\n  }\n}\n',
          unified: null,
        },
      ],
      output: "",
      command: null,
    },
    {
      kind: "tool_call",
      toolCallId: "dm-2",
      title: "Edit src/charts/palette.ts",
      toolKind: "edit",
      status: "in_progress",
      locations: ["src/charts/palette.ts"],
      diffs: [],
      output: "",
      command: null,
    },
    {
      kind: "tool_call",
      toolCallId: "dm-shot",
      title: "Capture dashboard screenshots (light, dark)",
      toolKind: "execute",
      status: "completed",
      locations: [
        "screenshots/dashboard-light.png",
        "screenshots/dashboard-dark.png",
        "screenshots/missing-retina.png",
      ],
      diffs: [],
      output: "Wrote screenshots/dashboard-light.png\nWrote screenshots/dashboard-dark.png",
      command: "npx playwright screenshot --full-page http://localhost:5173/analytics screenshots/",
    },
    {
      kind: "notice",
      level: "warn",
      text: "Armada closed while this agent was working. Resume to pick up where it left off.",
    },
  ]);

  out["a-deps"] = build("a-deps", 320, [
    { kind: "user_message", text: "Bump all deps to latest minor/major and fix whatever breaks." },
    {
      kind: "tool_call",
      toolCallId: "dp-1",
      title: "Run npx npm-check-updates -u",
      toolKind: "execute",
      status: "completed",
      locations: ["package.json"],
      diffs: [],
      output:
        "Upgrading /home/sam/Projects/infra/package.json\n[====================] 41/41 100%\n\n aws-cdk-lib    2.160.0  →  2.221.0\n constructs     10.3.0   →  10.4.2\n typescript     5.6.3    →  5.9.3\n vitest         2.1.4    →  3.2.4\n …\n\nRun npm install to install new versions.",
      command: "npx npm-check-updates -u",
    },
    {
      kind: "agent_message",
      text: "Upgraded **23 packages**. `cdk synth` now fails with 2 type errors in `lib/queue-stack.ts` (the `Queue` props were renamed). Fixing those next.",
    },
    { kind: "notice", level: "info", text: "Shut down by you." },
  ]);

  const cmpUser = "Debounce the product search input so we don't fire a request per keystroke. Keep it testable.";
  out["a-cmp-claude"] = build("a-cmp-claude", 45, [
    { kind: "user_message", text: cmpUser },
    {
      kind: "tool_call",
      toolCallId: "cc-1",
      title: "Create src/hooks/useDebouncedValue.ts",
      toolKind: "edit",
      status: "completed",
      locations: ["src/hooks/useDebouncedValue.ts"],
      diffs: [
        {
          path: "src/hooks/useDebouncedValue.ts",
          oldText: null,
          newText:
            'import { useEffect, useState } from "react";\n\nexport function useDebouncedValue<T>(value: T, delayMs = 250): T {\n  const [debounced, setDebounced] = useState(value);\n  useEffect(() => {\n    const t = setTimeout(() => setDebounced(value), delayMs);\n    return () => clearTimeout(t);\n  }, [value, delayMs]);\n  return debounced;\n}\n',
          unified: null,
        },
      ],
      output: "",
      command: null,
    },
    {
      kind: "agent_message",
      text: "Added a small `useDebouncedValue` hook (250 ms default) and used it in `SearchBox`. The query only runs when the debounced value changes.\n\n- No new dependencies\n- Timer is cleared on unmount, covered by a fake-timer test\n- `delayMs` is configurable per call site",
    },
  ]);
  out["a-cmp-codex"] = build("a-cmp-codex", 46, [
    { kind: "user_message", text: cmpUser },
    {
      kind: "agent_message",
      text: "Wrapped the fetch in `lodash.debounce` (300 ms) and memoized it with `useMemo` so the debounced function is stable across renders. Added `cancel()` on unmount.\n\n```tsx\nconst search = useMemo(() => debounce(runSearch, 300), [runSearch]);\nuseEffect(() => () => search.cancel(), [search]);\n```",
    },
  ]);
  out["a-cmp-grok"] = build("a-cmp-grok", 47, [
    { kind: "user_message", text: cmpUser },
    {
      kind: "agent_message",
      text: "Implemented a 300 ms timer **plus an `AbortController`**, so an in-flight request is aborted as soon as the user types again. That fixes the stale-results flicker too, not only the request volume.",
    },
  ]);

  out["a-react19"] = build("a-react19", 22, [
    {
      kind: "user_message",
      text: "Upgrade console-web to React 19. Replace deprecated APIs (forwardRef where it's no longer needed, string refs, legacy context) and get the test suite green.",
    },
    {
      kind: "plan",
      entries: [
        { content: "Bump react, react-dom and @types/*", status: "completed", priority: "high" },
        { content: "Run the official codemods", status: "completed", priority: "medium" },
        { content: "Fix remaining type errors (31 left)", status: "in_progress", priority: "high" },
        { content: "Get the test suite green", status: "pending", priority: "high" },
      ],
    },
    {
      kind: "tool_call",
      toolCallId: "r19-1",
      title: "Run npx codemod react/19/migration-recipe",
      toolKind: "execute",
      status: "completed",
      locations: [],
      diffs: [],
      output:
        "Running codemod react/19/migration-recipe…\n\n✔ replace-reactdom-render      12 files\n✔ replace-string-ref           3 files\n✔ remove-forward-ref          41 files\n✔ use-context-hook             9 files\n\nDone in 8.4s. 65 files modified.",
      command: "npx codemod react/19/migration-recipe",
    },
    {
      kind: "agent_message",
      text: "The codemods handled most of it: **65 files** updated, including 41 `forwardRef` removals. There are 31 type errors left, mostly `ref` props on function components and the new `useActionState` signature. Working through them now.",
    },
    {
      kind: "notice",
      level: "error",
      text: "Claude usage limit reached for Personal (Max 5x). Resets at 6:00 PM. Switch to another Claude account to keep going.",
    },
  ]);

  out["a-gemini"] = build("a-gemini", 20, [
    {
      kind: "user_message",
      text: "Summarize everything merged since v2.9 into release notes for v3.0. Group by breaking changes, features and fixes.",
    },
    {
      kind: "tool_call",
      toolCallId: "gm-1",
      title: "Run git log v2.9..HEAD --oneline",
      toolKind: "execute",
      status: "completed",
      locations: [],
      diffs: [],
      output:
        "e41a9c0 feat(auth): single-flight token refresh\n9b2d113 feat(billing)!: PaymentIntents\n77f0e3a fix(api): 429 retry-after header\n…\n(48 commits)",
      command: "git log v2.9..HEAD --oneline",
    },
    {
      kind: "agent_message",
      text: "## v3.0\n\n### Breaking\n- **Billing** now uses Stripe PaymentIntents. `chargeId` is optional; new `paymentIntentId` column.\n\n### Features\n- Single-flight token refresh removes the double-401 logout bug.\n- Public API rate limiting (120 req/min per key).\n\n### Fixes\n- `429` responses include `Retry-After`.",
    },
  ]);

  out["a-sse"] = build("a-sse", 60 * 27, [
    { kind: "user_message", text: "SSE or WebSockets for the live activity feed? We only push server → client." },
    {
      kind: "agent_message",
      text: "**Recommendation: SSE.** One-directional, works through our existing proxies and CDN without upgrade handling, auto-reconnects with `Last-Event-ID`, and is trivially load-balanced.",
    },
  ]);

  return out;
}

// ---------------------------------------------------------------- review diff

export function seedDiff(items: TimelineItem[]): AgentDiff {
  const files: AgentDiff["files"] = [];
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (it.kind !== "tool_call") continue;
    for (const d of it.diffs) {
      if (seen.has(d.path)) continue;
      seen.add(d.path);
      let unified = d.unified ?? "";
      if (!unified) {
        unified = createTwoFilesPatch(
          d.oldText ? `a/${d.path}` : "/dev/null",
          `b/${d.path}`,
          d.oldText ?? "",
          d.newText ?? "",
          undefined,
          undefined,
          { context: 3 },
        ).replace(/^=+\n/, "");
      } else if (!unified.startsWith("diff") && !unified.startsWith("---")) {
        unified = `--- a/${d.path}\n+++ b/${d.path}\n${unified}`;
      }
      if (!unified.startsWith("diff")) unified = `diff --git a/${d.path} b/${d.path}\n${unified}`;
      parts.push(unified.endsWith("\n") ? unified : `${unified}\n`);
      const adds = (unified.match(/^\+(?!\+\+)/gm) ?? []).length;
      const dels = (unified.match(/^-(?!--)/gm) ?? []).length;
      files.push({
        path: d.path,
        status: d.oldText === null && !d.unified ? "added" : "modified",
        additions: adds,
        deletions: dels,
        lfs: false,
      });
    }
  }
  return {
    files,
    patch: parts.join(""),
    ahead: files.length ? 2 : 0,
    uncommitted: Math.min(files.length, 3),
    truncated: false,
    lfs: null,
  };
}

/**
 * Huge fixture for `?bigdiff=1` (a game repo on Git LFS without git-lfs installed): ~3,400
 * binary/LFS assets plus ~100 text files, three of them 3-5k lines. Roughly 6-7 MB of patch.
 * `?lfs=ok` makes the tool present (subtle note only); `?lfs=none` drops the LFS block.
 */
let bigDiffCache: AgentDiff | null = null;
export function bigDiff(mode: "missing" | "ok" | "none" = "missing"): AgentDiff {
  if (!bigDiffCache) bigDiffCache = buildBigDiff();
  const lfs = mode === "none" ? null : { toolMissing: mode === "missing", hidden: 812 };
  return { ...bigDiffCache, lfs };
}

function buildBigDiff(): AgentDiff {
  const files: AgentDiff["files"] = [];
  const parts: string[] = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const ident = () =>
    ["token", "session", "queue", "frame", "render", "asset", "level", "state", "entity", "buffer"][
      Math.floor(rnd() * 10)
    ];
  const codeLine = (i: number) => {
    const a = ident();
    const b = ident();
    switch (i % 6) {
      case 0:
        return `export function ${a}${b[0].toUpperCase()}${b.slice(1)}${i}(input: ${a}Options, ctx: Context): Promise<${b}Result> {`;
      case 1:
        return `  const ${a} = await ctx.${b}.load(input.${a}Id, { retries: ${i % 5}, timeoutMs: ${1000 + (i % 40) * 50} });`;
      case 2:
        return `  if (!${a} || ${a}.version < ${i % 9}) throw new Error("stale ${a} for ${b}: " + String(input.${a}Id));`;
      case 3:
        return `  // TODO(${b}): handle ${a} eviction when the cache exceeds ${64 + (i % 8) * 16} entries`;
      case 4:
        return `  return { ${a}, ${b}: ${a}.items.map((x) => x.${b} ?? ${i}), done: true };`;
      default:
        return "}";
    }
  };
  const mk = (path: string, changed: number, added: boolean) => {
    const h: string[] = [`diff --git a/${path} b/${path}`];
    if (added) h.push("new file mode 100644", "index 0000000..1111111", "--- /dev/null", `+++ b/${path}`);
    else h.push("index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`);
    let adds = 0;
    let dels = 0;
    if (added) {
      h.push(`@@ -0,0 +1,${changed} @@`);
      for (let i = 0; i < changed; i++) h.push(`+${codeLine(i)}`);
      adds = changed;
    } else {
      let oldNo = 1;
      let newNo = 1;
      let left = changed;
      while (left > 0) {
        const block = Math.min(left, 20 + Math.floor(rnd() * 60));
        const dn = Math.floor(block / 3);
        const an = block - dn;
        const ctx = 3;
        h.push(`@@ -${oldNo},${ctx * 2 + dn} +${newNo},${ctx * 2 + an} @@ function ${ident()}()`);
        for (let c = 0; c < ctx; c++) h.push(` ${codeLine(oldNo + c)}`);
        for (let d = 0; d < dn; d++) h.push(`-${codeLine(oldNo + ctx + d)}`);
        for (let a = 0; a < an; a++) h.push(`+${codeLine(newNo + ctx + a + 1)}`);
        for (let c = 0; c < ctx; c++) h.push(` ${codeLine(oldNo + ctx + dn + c)}`);
        oldNo += ctx * 2 + dn + 40;
        newNo += ctx * 2 + an + 40;
        adds += an;
        dels += dn;
        left -= block;
      }
    }
    parts.push(`${h.join("\n")}\n`);
    files.push({ path, status: added ? "added" : "modified", additions: adds, deletions: dels, lfs: false });
  };
  const dirs = ["engine", "gameplay", "ui", "net", "tools", "ai", "audio", "render"];
  mk("src/engine/world_streaming.ts", 4800, true);
  mk("src/gameplay/generated_level_table.ts", 3600, true);
  mk("src/render/shader_cache_dump.ts", 3100, true);
  for (let i = 0; i < 97; i++) {
    const d = dirs[i % dirs.length];
    mk(`src/${d}/module_${String(i).padStart(3, "0")}.ts`, 300 + Math.floor(rnd() * 600), i % 9 === 0);
  }
  const exts = ["png", "wav", "fbx", "uasset", "psd", "ogg", "mp4", "dds"];
  for (let i = 0; i < 3400; i++) {
    const ext = exts[i % exts.length];
    const path = `Content/${["Art", "Audio", "Maps", "Props"][i % 4]}/Pack${String(Math.floor(i / 40)).padStart(2, "0")}/asset_${String(i).padStart(4, "0")}.${ext}`;
    const lfs = i % 8 !== 0;
    const status = i % 11 === 0 ? "added" : i % 17 === 0 ? "deleted" : "modified";
    if (lfs) {
      parts.push(
        `diff --git a/${path} b/${path}\nindex 3f1a2b4..9c8d7e6 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n version https://git-lfs.github.com/spec/v1\n-oid sha256:${"a1b2c3d4".repeat(8)}\n-size ${100000 + i}\n+oid sha256:${"e5f6a7b8".repeat(8)}\n+size ${120000 + i}\n`,
      );
    } else {
      parts.push(
        `diff --git a/${path} b/${path}\nindex 3f1a2b4..9c8d7e6 100644\nBinary files a/${path} and b/${path} differ\n`,
      );
    }
    files.push({ path, status, additions: 0, deletions: 0, lfs });
  }
  return { files, patch: parts.join(""), ahead: 3, uncommitted: 3500, truncated: false, lfs: null };
}

// ---------------------------------------------------------------- slash commands

export function commandsFor(provider: Provider): SlashCommand[] {
  if (provider === "claude") {
    return [
      { name: "compact", description: "Summarize the conversation to free up context", hint: "[instructions]" },
      { name: "review", description: "Review the current branch's changes", hint: null },
      { name: "init", description: "Create a CLAUDE.md with codebase notes", hint: null },
      { name: "security-review", description: "Security review of pending changes", hint: null },
      { name: "pr-comments", description: "Pull in comments from a GitHub pull request", hint: "<pr-number>" },
      { name: "context", description: "Show what's using the context window", hint: null },
      {
        name: "remote-control",
        description: "Continue this session from claude.ai/code or the Claude mobile app; `off` disconnects",
        hint: "[session name | off]",
      },
    ];
  }
  if (provider === "codex") {
    return [
      { name: "review", description: "Review uncommitted changes", hint: "[focus]" },
      { name: "compact", description: "Summarize the conversation to save context", hint: null },
      { name: "diff", description: "Show the git diff, including untracked files", hint: null },
      { name: "init", description: "Create an AGENTS.md with instructions", hint: null },
    ];
  }
  if (provider === "custom") return [];
  return [
    { name: "compact", description: "Compress the conversation history", hint: null },
    { name: "search", description: "Search the web and cite sources", hint: "<query>" },
  ];
}

// ---------------------------------------------------------------- schedules

export const MOCK_PROJECTS = [
  "/home/sam/Projects/atlas-api",
  "/home/sam/Projects/storefront",
  "/home/sam/Projects/console-web",
  "/home/sam/Projects/infra",
  "/home/sam/Projects/design-tokens",
  "/home/sam/code/oss/vitest-plugin-armada",
  "/home/sam/code/scratch/rust-cli",
];

export function seedSchedules(): Schedule[] {
  return [
    {
      id: "sch-audit",
      name: "Nightly dependency audit",
      enabled: true,
      provider: "claude",
      accountId: "acc-claude-work",
      projectPath: "/home/sam/Projects/atlas-api",
      prompt:
        "Run npm audit, triage every advisory by real exploitability in our code, and open a branch fixing anything high or critical.",
      worktree: true,
      time: "02:00",
      days: [],
      lastRunAt: min(60 * 14),
      lastAgentId: null,
      customAgentId: null,
      updatedAt: min(60 * 24 * 6),
      lastError: null,
      permissionMode: null,
    },
    {
      id: "sch-deps",
      name: "Weekly dependency bump",
      enabled: true,
      provider: "grok",
      accountId: "acc-grok-sys",
      projectPath: "/home/sam/Projects/infra",
      prompt: "Bump all deps to latest minor/major and fix whatever breaks.",
      worktree: true,
      time: "09:00",
      days: [1],
      lastRunAt: min(60 * 5 + 20),
      lastAgentId: "a-deps",
      customAgentId: null,
      updatedAt: min(60 * 24 * 20),
      lastError: null,
      permissionMode: null,
    },
    {
      id: "sch-triage",
      name: "Morning issue triage",
      enabled: false,
      provider: "codex",
      accountId: "acc-codex-sys",
      projectPath: "/home/sam/Projects/storefront",
      prompt:
        "Read the GitHub issues opened since yesterday, label them, and draft replies for anything that's a duplicate or needs more info.",
      worktree: false,
      time: "08:30",
      days: [1, 2, 3, 4, 5],
      lastRunAt: null,
      lastAgentId: null,
      customAgentId: null,
      updatedAt: min(60 * 24 * 2),
      lastError: "Didn't start at 08:30: Codex · Personal hit its usage limit (resets 10:00).",
      permissionMode: "ask",
    },
  ];
}

// ---------------------------------------------------------------- sample screenshots

/** A UI-looking SVG "screenshot" (stands in for PNGs the real backend reads from disk). */
export function mockScreenshot(name: string, seed = name): Attachment {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  const title = name.replace(/\.[a-z]+$/i, "").replace(/[-_]+/g, " ");
  const esc = (t: string) =>
    t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600">
<rect width="960" height="600" fill="#f6f7f9"/>
<rect width="960" height="56" fill="#ffffff"/><rect y="56" width="960" height="1" fill="#e3e6ea"/>
<circle cx="32" cy="28" r="9" fill="hsl(${hue},70%,50%)"/><rect x="52" y="20" width="120" height="16" rx="4" fill="#1f2937"/>
<rect x="760" y="16" width="168" height="24" rx="12" fill="#eef1f4"/>
<rect x="48" y="96" width="520" height="440" rx="14" fill="#ffffff" stroke="#e3e6ea"/>
<text x="76" y="140" font-family="sans-serif" font-size="22" font-weight="700" fill="#111827">${esc(title)}</text>
<rect x="76" y="168" width="464" height="44" rx="8" fill="#f3f4f6" stroke="#e5e7eb"/>
<rect x="76" y="228" width="464" height="44" rx="8" fill="#f3f4f6" stroke="#e5e7eb"/>
<rect x="76" y="288" width="220" height="44" rx="8" fill="#f3f4f6" stroke="#e5e7eb"/>
<rect x="320" y="288" width="220" height="44" rx="8" fill="#f3f4f6" stroke="#e5e7eb"/>
<rect x="76" y="460" width="464" height="48" rx="10" fill="hsl(${hue},70%,48%)"/>
<text x="308" y="490" font-family="sans-serif" font-size="17" font-weight="600" fill="#ffffff" text-anchor="middle">Pay $48.00</text>
<rect x="600" y="96" width="312" height="260" rx="14" fill="#ffffff" stroke="#e3e6ea"/>
<rect x="628" y="128" width="72" height="72" rx="10" fill="hsl(${(hue + 40) % 360},55%,85%)"/>
<rect x="716" y="136" width="160" height="14" rx="4" fill="#374151"/><rect x="716" y="162" width="96" height="12" rx="4" fill="#9ca3af"/>
<rect x="628" y="232" width="256" height="1" fill="#e5e7eb"/>
<rect x="628" y="256" width="90" height="12" rx="4" fill="#6b7280"/><rect x="820" y="256" width="64" height="12" rx="4" fill="#111827"/>
<rect x="628" y="292" width="90" height="12" rx="4" fill="#6b7280"/><rect x="820" y="292" width="64" height="12" rx="4" fill="#111827"/>
</svg>`;
  return { name, mimeType: "image/svg+xml", data: btoa(svg) };
}
