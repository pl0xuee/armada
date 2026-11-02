// What a computer can run: the curated model list, memory arithmetic and the
// context-window choice. Mirrors crates/kvistcode-core/src/local_ctx.rs
// (`pick_context`), which makes the real decision when an agent starts; this copy
// only previews it. Sizes are Ollama library figures (see docs/LOCAL-MODELS.md);
// KV-cache numbers are estimates.
import type { Hardware, LocalModel } from "./types";

const GIB = 1 << 30;
const OVERHEAD = 1.5 * GIB;

export const TARGET_CONTEXT = 65_536;
export const MIN_GOOD_CONTEXT = 32_768;
const FLOOR_CONTEXT = 8_192;

export type Quality = "starter" | "solid" | "strong";

export interface CatalogModel {
  name: string;
  title: string;
  blurb: string;
  /** Download size in GB. */
  sizeGb: number;
  /** Largest context window the model supports, in tokens. */
  maxContext: number;
  /** Estimated KV-cache bytes per token. */
  kvBytesPerToken: number;
  quality: Quality;
}

export const CATALOG: CatalogModel[] = [
  {
    name: "gemma4:e4b",
    title: "Gemma 4 E4B",
    blurb: "Small and quick; chat, explaining code, small edits",
    sizeGb: 7.2,
    maxContext: 131072,
    kvBytesPerToken: 40 * 1024,
    quality: "starter",
  },
  {
    name: "qwen3.5:9b",
    title: "Qwen 3.5 9B",
    blurb: "Compact all-rounder for laptops",
    sizeGb: 6.6,
    maxContext: 262144,
    kvBytesPerToken: 36 * 1024,
    quality: "starter",
  },
  {
    name: "gpt-oss:20b",
    title: "gpt-oss 20B",
    blurb: "OpenAI's open model; reliable with tools",
    sizeGb: 14,
    maxContext: 131072,
    kvBytesPerToken: 48 * 1024,
    quality: "solid",
  },
  {
    name: "devstral-small-2:24b",
    title: "Devstral Small 2 24B",
    blurb: "Built for coding agents; heavy on memory at long context",
    sizeGb: 15,
    maxContext: 393216,
    kvBytesPerToken: 160 * 1024,
    quality: "solid",
  },
  {
    name: "qwen3-coder:30b",
    title: "Qwen3-Coder 30B",
    blurb: "Best all-round coding model for 24 GB and up",
    sizeGb: 19,
    maxContext: 262144,
    kvBytesPerToken: 96 * 1024,
    quality: "strong",
  },
  {
    name: "qwen3.6:27b",
    title: "Qwen 3.6 27B",
    blurb: "Newer dense model, strong at agentic coding",
    sizeGb: 17,
    maxContext: 262144,
    kvBytesPerToken: 128 * 1024,
    quality: "strong",
  },
  {
    name: "gpt-oss:120b",
    title: "gpt-oss 120B",
    blurb: "Closest to hosted quality; needs a very large GPU or Mac",
    sizeGb: 65,
    maxContext: 131072,
    kvBytesPerToken: 72 * 1024,
    quality: "strong",
  },
];

export const QUALITY_NOTE =
  "Local models are best for routine work: small fixes, tests, docs, explaining code. Hard multi-file changes still go better on a hosted model.";

const QUALITY_RANK: Record<Quality, number> = { starter: 0, solid: 1, strong: 2 };

/** The window to run with: 64k when memory allows, less when it doesn't, never above the model's limit. */
export function pickContext(
  modelMax: number | null,
  memory: number | null,
  weights: number | null,
  kvPerToken: number,
  requested: number | null = null,
): number {
  const cap = modelMax && modelMax > 0 ? modelMax : Number.POSITIVE_INFINITY;
  if (requested && requested > 0) return Math.min(requested, cap);
  const want = Math.min(TARGET_CONTEXT, cap);
  if (memory == null || weights == null) return want;
  const fits = Math.max(0, memory - weights - OVERHEAD) / Math.max(1, kvPerToken);
  const step = [65_536, 49_152, 32_768, 24_576, 16_384, FLOOR_CONTEXT].find((c) => c <= want && c <= fits);
  return step ?? Math.min(FLOOR_CONTEXT, want);
}

const KNOWN_KV: [string, number][] = [
  ["gpt-oss", 48],
  ["qwen3-coder", 96],
  ["devstral", 160],
  ["gemma4", 100],
  ["llama3.2", 112],
];

/** Estimated KV-cache bytes per token for any model (mirrors `kv_bytes_per_token` in Rust). */
export function kvBytesFor(m: Pick<LocalModel, "id" | "parameters">): number {
  const id = m.id.toLowerCase();
  const known = KNOWN_KV.find(([k]) => id.includes(k));
  if (known) return known[1] * 1024;
  const billions = Number.parseFloat(m.parameters ?? "") || 14;
  return Math.max(16 * 1024, Math.floor(billions * 4096));
}

export type FitLevel = "great" | "ok" | "tight" | "slow" | "no" | "unknown";

export interface Fit {
  level: FitLevel;
  /** The window this model would get here. */
  context: number;
  note: string;
}

const kb = (tokens: number) => `${Math.round(tokens / 1024)}k`;

/** Whether a model fits this computer, with a plain-words note. */
export function fitModel(m: CatalogModel, hw: Hardware | null): Fit {
  const weights = m.sizeGb * 1e9;
  if (!hw || hw.modelMemoryBytes == null) {
    return { level: "unknown", context: MIN_GOOD_CONTEXT, note: "Couldn't read this computer's memory" };
  }
  const mem = hw.modelMemoryBytes;
  const context = pickContext(m.maxContext, mem, weights, m.kvBytesPerToken);
  if (hw.accel === "cpu") {
    return weights + OVERHEAD <= mem
      ? { level: "slow", context, note: "No GPU found: runs on the CPU, several times slower" }
      : { level: "no", context, note: "Too big for this computer's memory" };
  }
  if (weights + OVERHEAD > mem) {
    const ram = hw.ramBytes ?? 0;
    return weights + OVERHEAD <= ram * 0.8
      ? {
          level: "slow",
          context: Math.min(context, MIN_GOOD_CONTEXT),
          note: "Doesn't fit in GPU memory: spills to the CPU and runs slowly",
        }
      : { level: "no", context, note: "Too big for this computer" };
  }
  if (context >= TARGET_CONTEXT) return { level: "great", context, note: `Fits with a ${kb(context)} window` };
  if (context >= MIN_GOOD_CONTEXT) return { level: "ok", context, note: `Fits with a ${kb(context)} window` };
  return { level: "tight", context, note: `Fits, but only with a ${kb(context)} window` };
}

export const FIT_LABEL: Record<FitLevel, string> = {
  great: "Runs well",
  ok: "Runs well",
  tight: "Tight fit",
  slow: "Runs slowly",
  no: "Too big",
  unknown: "Unknown fit",
};

/** The strongest model that runs comfortably here, if any. */
export function bestFor(hw: Hardware | null): CatalogModel | null {
  const ranked = CATALOG.map((m) => ({ m, fit: fitModel(m, hw) }))
    .filter((x) => x.fit.level === "great" || x.fit.level === "ok")
    .sort((a, b) => QUALITY_RANK[b.m.quality] - QUALITY_RANK[a.m.quality] || b.m.sizeGb - a.m.sizeGb);
  return ranked[0]?.m ?? null;
}

/** The catalog, best fit first: what runs well (best on top), then the rest. */
export function rankedCatalog(hw: Hardware | null): { model: CatalogModel; fit: Fit; best: boolean }[] {
  const best = bestFor(hw);
  const order: Record<FitLevel, number> = { great: 0, ok: 0, tight: 1, unknown: 1, slow: 2, no: 3 };
  return CATALOG.map((model) => ({ model, fit: fitModel(model, hw), best: model.name === best?.name })).sort(
    (a, b) =>
      order[a.fit.level] - order[b.fit.level] ||
      QUALITY_RANK[b.model.quality] - QUALITY_RANK[a.model.quality] ||
      b.model.sizeGb - a.model.sizeGb,
  );
}

/** Is there room on disk for a download of `sizeGb` (10% spare)? True when unknown. */
export function diskAllows(hw: Hardware | null, sizeGb: number): boolean {
  return hw?.diskFreeBytes == null || hw.diskFreeBytes >= sizeGb * 1e9 * 1.1;
}

/** One line about this computer: "NVIDIA GeForce RTX 4090 · 24 GB GPU memory · 64 GB RAM". */
export function describeHardware(hw: Hardware): string {
  const gb = (b: number) => `${Math.round(b / GIB)} GB`;
  const parts: string[] = [];
  const gpu = hw.gpus.find((g) => g.vendor === "nvidia" || g.vendor === "amd") ?? hw.gpus[0];
  if (hw.unifiedMemory && hw.ramBytes)
    parts.push(`${gpu?.name.replace(" GPU", "") ?? "Apple Silicon"} · ${gb(hw.ramBytes)} shared memory`);
  else if (gpu && gpu.vramBytes) parts.push(`${gpu.name} · ${gb(gpu.vramBytes)} GPU memory`);
  else if (gpu && hw.accel !== "gpu") parts.push(`${gpu.name}`);
  else parts.push("No dedicated GPU found");
  if (!hw.unifiedMemory && hw.ramBytes) parts.push(`${gb(hw.ramBytes)} RAM`);
  return parts.join(" · ");
}

export const CONTEXT_CHOICES: { value: number | null; label: string }[] = [
  { value: null, label: "Automatic (recommended)" },
  { value: 16_384, label: "16k tokens" },
  { value: 32_768, label: "32k tokens" },
  { value: 65_536, label: "64k tokens" },
  { value: 131_072, label: "128k tokens" },
];

/** Plain-words verdict on a context window for agent work. */
export function contextVerdict(tokens: number): { ok: boolean; text: string } {
  return tokens >= MIN_GOOD_CONTEXT
    ? { ok: true, text: `${kb(tokens)} window` }
    : { ok: false, text: `${kb(tokens)} window is small for agent work: it forgets files and instructions` };
}
