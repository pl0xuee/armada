# Local models for agentic coding: research notes

Written 2026-11-01 for Kvistcode. Items marked **(unverified)** come from memory or a single third-party blog and
were not confirmed against a primary document. Nothing here was run on a real GPU: the research machine has no
Ollama, LM Studio or NVIDIA driver.

## 1. What decides whether a local agent works

Ranked by how often it is the cause of "the local agent is useless":

1. **Context window.** Ollama's default context depends on VRAM: under 24 GiB it is **4k tokens**, 24-48 GiB 32k,
   48 GiB and up 256k. A coding agent's system prompt plus tool definitions plus a few file reads exceeds 4k, and the
   server silently drops the start of the prompt. Ollama's docs and its Codex integration page both say to use **at
   least 64k** for agents. The OpenAI-compatible API (`/v1/responses`) has no way to set the context size; the
   documented workaround is a Modelfile (`FROM <model>` + `PARAMETER num_ctx N`) built with `ollama create`, then
   requesting the new name. `OLLAMA_CONTEXT_LENGTH` (server env) or the app slider are the global alternatives.
   Verify with `ollama ps` (CONTEXT column). Sources: docs.ollama.com context-length, faq,
   api/openai-compatibility, integrations/codex.
2. **Tool calling.** Codex needs a model that emits function calls reliably. Models without a `tools` capability
   print tool calls as text or claim edits that never happened. Ollama lists `tools` in `/api/show` `capabilities`;
   LM Studio reports capabilities in `/api/v0/models`. vLLM needs `--enable-auto-tool-choice` plus a model-specific
   `--tool-call-parser` (Qwen3-Coder `qwen3_xml`, gpt-oss `openai`, Mistral/Devstral `mistral`, GLM `glm45`/`glm47`).
   Arbitrary GGUFs from Hugging Face often ship chat templates that break on Codex's tool schema (LM Studio: "Error
   rendering prompt with jinja template"); prefer catalog builds.
3. **Wire protocol.** Codex only speaks the **Responses API** (`wire_api = "responses"` is the only accepted value).
   Ollama serves `/v1/responses` since **v0.13.3** (stateless only: no `previous_response_id`). LM Studio serves it
   from 0.3.29. llama.cpp's server and vLLM serve it too. An older server answers 404 on every request: tell the
   user to update.
4. **Compaction needs the real window.** Codex compacts based on `model_context_window` and
   `model_auto_compact_token_limit`. For an unknown local model these are not known, so set them to the window the
   server really runs with. The auto-compact limit is capped at 90% of the window (one source says clamped,
   another says ignored above that: stay under). Source: Codex config reference.
5. **Memory fit.** Weights + KV cache + overhead must fit in VRAM; spilling to CPU makes generation several times
   slower (`ollama ps` PROCESSOR shows e.g. `48%/52% CPU/GPU`). KV bytes per token = 2 x layers x KV heads x head dim
   x bytes per element. Estimates (architecture values from memory, **unverified**): gpt-oss-20b about 48 KB/token
   (1.5 GB at 32k, 3 GB at 64k, less with its sliding-window layers); Qwen3-Coder-30B-A3B about 96 KB/token (3 GB at
   32k, 6 GB at 64k); Devstral-Small 24B about 160 KB/token (5 GB at 32k, 10 GB at 64k). Quantizing the KV cache
   (`OLLAMA_KV_CACHE_TYPE=q8_0`, half the memory of f16; `q4_0` a quarter) needs flash attention and is global.
6. **Reasoning effort.** Ollama maps `reasoning_effort` / `reasoning.effort` to model thinking; supported values per
   model come from `/api/show`. For local models keep effort at default or `low`/`medium`; high effort on a small
   model mostly burns context and time.

## 2. Models (Ollama library, checked 2026-11-01)

Sizes are Ollama download sizes. The library moves quickly, so Kvistcode treats its curated list as hints and the
server's `/api/show` as the truth.

| Model (tag) | Download | Max ctx | Notes |
|---|---|---|---|
| `gemma4:e4b` | 6.6-9.5 GB | 128k | Smallest sensible agent model; vision, thinking |
| `qwen3.5:9b` | 6.6-7.6 GB | 256k | Small; tools, thinking, vision |
| `gemma4:12b` | 7.7-8 GB | 256k | 16 GB machines |
| `gpt-oss:20b` | 14 GB | 128k | MXFP4, about 16 GB memory; reliable tool caller at this size |
| `devstral-small-2:24b` | 15 GB | 384k | Mistral coding-agent model; KV cache is heavy |
| `qwen3.6:27b`, `qwen3.8:27b` | 17-18 GB | 256k | Dense 27B, "agentic coding" focus |
| `qwen3-coder:30b` (30B-A3B MoE) | 19 GB | 256k | Fast for its size (3B active); best all-rounder for 24-32 GB |
| `qwen3.6:35b` (A3B) | 23 GB | 256k | MoE |
| `gpt-oss:120b` | 65 GB | 128k | 80 GB GPU or 96-128 GB unified memory |
| `qwen3-coder-next` | 52 GB (q4) | 256k | 64 GB+ Mac or multi-GPU |

Tiers (memory available to the model: VRAM, or Apple unified memory):

| Tier | Practical pick | Honest expectation |
|---|---|---|
| under 8 GB | `qwen3.5:4b`, `gemma4:e4b` | Chat, explaining code, single-file edits. Not an agent replacement. |
| 8-12 GB | `qwen3.5:9b`, `gemma4:12b` | Small edits; long tasks drift. |
| 16 GB | `gpt-oss:20b` at 32k | Usable for 1-3 file tasks. |
| 24-32 GB | `qwen3-coder:30b` or `gpt-oss:20b` at 64k | The sweet spot for routine tasks. |
| 48-64 GB | `qwen3.6:27b`, `qwen3-coder:30b` q8 | Better quality, larger context. |
| 96 GB+ | `gpt-oss:120b`, `qwen3-coder-next` | Closest to hosted quality, still below frontier models. |

Quality limit to say out loud: local models of this size fall behind hosted frontier models on multi-file refactors
and long tasks. The win is routine work, which also saves subscription usage. Sources: ollama.com library tag pages;
a third-party Codex-with-local-models guide. SEO "best local LLM" rankings disagree with each other and were not used.

## 3. Servers

| Server | Default URL | Introspection | Context control | Auth |
|---|---|---|---|---|
| Ollama | `127.0.0.1:11434` | `/api/version`, `/api/tags`, `POST /api/show` (`capabilities`, `model_info.*.context_length`, `parameters`), `/api/ps` (`size`, `size_vram`, `expires_at`; `context_length` in recent versions, **unverified**) | derived Modelfile model, `OLLAMA_CONTEXT_LENGTH`, `options.num_ctx` (native API only) | none |
| LM Studio | `127.0.0.1:1234` | `/api/v0/models` (state, max/loaded context, capabilities), `/api/v1/models/load` with `context_length`; CLI `lms load --context-length`, `lms ps`, `lms server start` | per-load context; default often too small | API tokens (0.4+) |
| llama.cpp `llama-server` | `127.0.0.1:8080` (**unverified**) | `/health`, `/props` (`default_generation_settings.n_ctx`, `total_slots`, `chat_template`), `/slots` | `-c/--ctx-size` | `--api-key` |
| vLLM | `:8000` | `/v1/models`, `/version` | `--max-model-len` | `--api-key` |
| Jan, llamafile | 1337 / 8080 (**unverified**) | OpenAI-compatible only | in-app | Jan requires a key |

Kvistcode treats everything except Ollama and LM Studio as "Custom (OpenAI-compatible)" and recognizes llama.cpp from
`/props`.

Concurrency (Ollama): `OLLAMA_NUM_PARALLEL` default 1 (RAM scales as parallel x context); `OLLAMA_MAX_LOADED_MODELS`
default 3 per GPU (1 on Windows Radeon); `OLLAMA_MAX_QUEUE` 512; models unload after 5 minutes (`OLLAMA_KEEP_ALIVE`
or `keep_alive`; `keep_alive: 0` unloads now). Several agents on one GPU should share one model so it loads once.
Flash attention is automatic where supported.

GPUs (docs.ollama.com/gpu): NVIDIA compute capability 5.0+ (driver 550+); AMD via ROCm 7 (Linux broad; Windows RX
7600-7900 only); Apple via Metal; Vulkan (default on Windows and Linux) adds Intel and other AMD GPUs. Apple Silicon is
unified memory but macOS limits GPU-wired memory to roughly two thirds to three quarters of RAM by default
(**unverified**; `sysctl iogpu.wired_limit_mb`).

## 4. Detecting hardware without heavy dependencies

* RAM: Linux `/proc/meminfo`; macOS `sysctl -n hw.memsize`; Windows `Win32_ComputerSystem.TotalPhysicalMemory`.
* NVIDIA, all OSes: `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` (MiB).
* AMD on Linux: `/sys/class/drm/card*/device/mem_info_vram_total` and `vendor` 0x1002. Intel (0x8086) integrated
  graphics share RAM: treat as CPU-class.
* macOS: arm64 = unified memory; Intel Macs: CPU class.
* Windows non-NVIDIA: `Win32_VideoController.AdapterRAM` is 32-bit and misreports above 4 GB; the registry value
  `HardwareInformation.qwMemorySize` is right. When unreadable, say "GPU memory unknown" instead of guessing.
* Free disk: `statvfs` (unix) / `GetDiskFreeSpaceExW` (Windows) on `OLLAMA_MODELS`, else `~/.ollama`.

Fit rule: budget = VRAM (70% of RAM on Apple Silicon) minus 1.5 GB overhead; a model fits when download size + KV
estimate at the chosen context <= budget. With no usable GPU it runs on CPU RAM: possible but slow; say so.

## 5. Hybrid use to save subscription usage

* Highest value: run whole routine tasks on a local agent (renames, tests, small fixes, docs, explaining code) and
  keep the hosted agent for hard work. Kvistcode already hands agents off between accounts.
* Titles and summaries are cheap on hosted models. Kvistcode today makes no model call for them: titles come from the
  CLI or the first prompt line and a handoff brief is a plain transcript. The one place a local call directly
  reduces hosted input is condensing a long handoff transcript before a hosted agent reads it.
* Local tokens must never count against hosted budgets and are free in spend displays.

## 6. Remote GPU boxes

* Servers bind to loopback by default. Keep that and use **Tailscale**: `tailscale serve` terminates TLS and proxies
  to loopback, reachable at `https://<machine>.<tailnet>.ts.net` with no open ports. The alternative is
  `OLLAMA_HOST=0.0.0.0` on a trusted LAN. `OLLAMA_ORIGINS` only matters for browser clients.
* OpenAI-compatible auth is `Authorization: Bearer <key>`. Codex reads the key from the env var named by `env_key`
  (Kvistcode keeps it in the OS keychain and passes `KVISTCODE_LOCAL_API_KEY`).
* Remote means prompts and code leave the machine; the UI warns.

## 7. Codex facts used by Kvistcode

`model_providers.<id>`: `base_url`, `wire_api` (only `responses`), `env_key`, `http_headers`, `env_http_headers`,
`query_params`, `request_max_retries` (4), `stream_idle_timeout_ms` (300000), `stream_max_retries` (5). Built-in ids
`openai`, `ollama`, `lmstudio` are reserved (Kvistcode uses `kvistcode_local`). `model_context_window`,
`model_auto_compact_token_limit`, `model_reasoning_effort` are top-level. A big prompt on a slow local model can
exceed the stream idle timeout while the server is still processing the prompt, so Kvistcode raises it for local.

Sources: docs.ollama.com (faq, context-length, gpu, api/openai-compatibility, integrations/codex); Ollama API doc on
GitHub; lmstudio.ai/docs/developer/rest; llama.cpp `tools/server/README.md`; docs.vllm.ai tool calling; Codex config
reference (learn.chatgpt.com/docs/config-file/config-reference); ollama.com library tag pages. Fetched 2026-11-01.
