// Pure helpers for local model servers (Ollama, LM Studio, any OpenAI-compatible
// endpoint): labels, model descriptions, remembered choices, recommended downloads.
import type { Account, LocalKind, LocalModel, LocalServer, PullProgress } from "./types";

export const LOCAL_KIND_LABEL: Record<LocalKind, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  custom: "Custom server",
};

export const OLLAMA_URL = "http://127.0.0.1:11434";
export const LMSTUDIO_URL = "http://127.0.0.1:1234";

export const INSTALL_URL: Partial<Record<LocalKind, string>> = {
  ollama: "https://ollama.com/download",
  lmstudio: "https://lmstudio.ai",
};

export const SMALL_MODEL_NOTE =
  "Small local models can struggle with tool use and long tasks. Expect to guide them more than a hosted model.";

/** Ollama models that support tool calling, with rough download and memory needs. */
export interface RecommendedModel {
  name: string;
  title: string;
  blurb: string;
  /** Approximate download size in GB. */
  sizeGb: number;
  /** Approximate RAM / VRAM to run it comfortably, in GB. */
  ramGb: number;
}

export const RECOMMENDED_MODELS: RecommendedModel[] = [
  { name: "qwen3:8b", title: "Qwen3 8B", blurb: "Small and quick; fits most laptops", sizeGb: 5.2, ramGb: 8 },
  { name: "gpt-oss:20b", title: "gpt-oss 20B", blurb: "OpenAI's open model; good all-rounder", sizeGb: 14, ramGb: 16 },
  { name: "devstral:24b", title: "Devstral 24B", blurb: "Built for coding agents", sizeGb: 14, ramGb: 24 },
  { name: "qwen3-coder:30b", title: "Qwen3-Coder 30B", blurb: "Strongest coding model here", sizeGb: 19, ramGb: 24 },
];

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e11 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1024)}k`;
  return String(tokens);
}

/** "30.5B · Q4_K_M · 256k context · 19 GB", skipping what the server doesn't say. */
export function describeModel(m: LocalModel): string {
  const parts: string[] = [];
  if (m.parameters) parts.push(m.parameters);
  if (m.quantization) parts.push(m.quantization);
  if (m.contextLength) parts.push(`${formatContext(m.contextLength)} context`);
  if (m.sizeBytes) parts.push(formatBytes(m.sizeBytes));
  return parts.join(" · ");
}

/** "Running · 4 models" / "Not running". */
export function serverStatusText(running: boolean, models: number): string {
  if (!running) return "Not running";
  return `Running · ${models} ${models === 1 ? "model" : "models"}`;
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    // Only a real IPv4 loopback literal (127.0.0.0/8), ::1, or localhost / *.localhost.
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (v4) return v4[1] === "127" && v4.slice(1).every((o) => Number(o) <= 255);
    return host === "localhost" || host.endsWith(".localhost") || host === "::1";
  } catch {
    return false;
  }
}

/** Only http(s) addresses are accepted; returns the cleaned URL or null. */
export function cleanServerUrl(raw: string): string | null {
  const t = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/?#]+/i.test(t) || /[\s?#]/.test(t)) return null;
  return t;
}

export function pullPercent(p: Pick<PullProgress, "total" | "completed">): number | null {
  if (!p.total || p.completed == null) return null;
  return Math.max(0, Math.min(100, Math.round((p.completed / p.total) * 100)));
}

/** Download progress as text: "pulling manifest", "42% · 2.2 of 5.2 GB". */
export function pullText(p: PullProgress): string {
  const pct = pullPercent(p);
  if (pct == null || !p.total) return p.status;
  return `${pct}% · ${formatBytes(p.completed ?? 0)} of ${formatBytes(p.total)}`;
}

export function serverLabel(s: LocalServer | null | undefined): string {
  return s ? LOCAL_KIND_LABEL[s.kind] : "Local model";
}

/** The remembered model if the server still has it, else the first one. */
export function pickLocalModel(models: LocalModel[], remembered: string | null | undefined): string {
  if (remembered && models.some((m) => m.id === remembered)) return remembered;
  return models[0]?.id ?? "";
}

const MODEL_KEY = "armada.localModel.v1";

function readMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(MODEL_KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The model last used with this local account. */
export function recallLocalModel(accountId: string): string | null {
  return readMap()[accountId] ?? null;
}

export function rememberLocalModel(accountId: string, model: string) {
  if (!model) return;
  try {
    localStorage.setItem(MODEL_KEY, JSON.stringify({ ...readMap(), [accountId]: model }));
  } catch {
    /* storage unavailable: the choice just isn't remembered */
  }
}

export function isLocalAccount(a: Pick<Account, "provider"> | undefined | null): boolean {
  return a?.provider === "local";
}
