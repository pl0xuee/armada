import type {
  Agent,
  Attachment,
  CreateAgentRequest,
  Session,
  StateSnapshot,
  TimelineItem,
} from "./types";

export type HttpMethod = "GET" | "POST" | "DELETE";

/** An HTTP failure, normalised. `status` 0 = the request never got a response. */
export class ApiError extends Error {
  readonly status: number;
  /** Message from the server's `{ "error": string }` body, if any. */
  readonly serverMessage: string | null;

  constructor(status: number, serverMessage: string | null, message?: string) {
    super(message ?? describeStatus(status, serverMessage));
    this.name = "ApiError";
    this.status = status;
    this.serverMessage = serverMessage;
  }

  get isNetwork() {
    return this.status === 0;
  }
  get isUnauthorized() {
    return this.status === 401;
  }
  get isRateLimited() {
    return this.status === 429;
  }
}

export function describeStatus(
  status: number,
  serverMessage: string | null,
): string {
  if (serverMessage && /shutting down/i.test(serverMessage))
    return "Armada is shutting down on your computer. Try again once it's running.";
  switch (status) {
    case 0:
      return "Can't reach Armada. Check that your computer is awake and reachable.";
    case 401:
      return "This device was unpaired.";
    case 403:
      return serverMessage ?? "This link is read-only.";
    case 404:
      return serverMessage ?? "That agent no longer exists.";
    case 408:
      return serverMessage ?? "Armada took too long to respond.";
    case 413:
      return (
        serverMessage ??
        "That request is too large. Try fewer or smaller photos."
      );
    case 421:
      // The server only answers on the addresses it advertises (DNS-rebinding guard).
      return "Open the link from the QR code or the LAN address shown in Armada.";
    case 429:
      return serverMessage ?? "Too many attempts. Try again in a few minutes.";
    case 503:
      return serverMessage ?? "Armada isn't accepting connections right now.";
    default:
      if (status >= 500)
        return serverMessage
          ? `Armada hit an error: ${serverMessage}`
          : "Armada hit an error. Try again.";
      return serverMessage ?? `Request failed (${status}).`;
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Random UUID v4 for Idempotency-Key. `crypto.randomUUID` only exists in
 * secure contexts and the remote is usually plain http on the LAN, so it's
 * built from `getRandomValues` (available everywhere).
 */
export function newIdempotencyKey(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * When to retry an idempotent request (same key, so it can't run twice):
 * lost connections and client timeouts a couple of times, and "still being
 * processed" (the first attempt is running) for up to about a minute.
 * Returns the delay in ms, or null to give up.
 */
export function retryDelay(e: unknown, attempt: number): number | null {
  if (!(e instanceof ApiError)) return null;
  if (e.status === 409 && /still being processed/i.test(e.serverMessage ?? ""))
    return attempt < 30 ? 2_000 : null;
  if (e.status === 0 || (e.status === 408 && e.serverMessage === null))
    return attempt < 2 ? 1_500 * (attempt + 1) : null;
  return null;
}

export interface StreamHandlers {
  signal: AbortSignal;
  /** The stream is established (HTTP 200 received). */
  onOpen: () => void;
  /** One SSE `data:` payload (already joined across lines). */
  onMessage: (data: string) => void;
  /** Any bytes arrived, including heartbeat comments. */
  onActivity: () => void;
}

export interface RequestOptions {
  /** Sent as Idempotency-Key: a retry with the same key gets the first result. */
  idempotencyKey?: string;
  /** Upload progress, 0..1 (uses XHR, which reports it; fetch doesn't). */
  onProgress?: (fraction: number) => void;
  /** Instead of the usual 15 s, for work that legitimately takes long (git hooks). */
  timeoutMs?: number;
  /** Let the request finish after the page is hidden or closed (iOS suspends it fast). */
  keepalive?: boolean;
}

/**
 * Everything the app needs from the server. Implemented over HTTP for real use
 * and in memory by the dev mock, so the UI can't tell them apart.
 */
export interface Backend {
  readonly kind: "http" | "mock";
  request(
    method: HttpMethod,
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<unknown>;
  /** Resolves when the server ends the stream; rejects on failure (ApiError for HTTP statuses). */
  stream(handlers: StreamHandlers): Promise<void>;
}

/** Run an idempotent request, retrying per `retryDelay` with the same key. */
export async function requestIdempotent(
  b: Backend,
  method: HttpMethod,
  path: string,
  body: unknown,
  key: string,
  onProgress?: (fraction: number) => void,
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await b.request(method, path, body, {
        idempotencyKey: key,
        onProgress,
      });
    } catch (e) {
      const wait = retryDelay(e, attempt);
      if (wait === null) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const agentPath = (id: string, rest = "") =>
  `/api/agents/${encodeURIComponent(id)}${rest}`;

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | string;
  additions: number;
  deletions: number;
}

export interface AgentDiffSummary {
  files: DiffFile[];
  ahead: number;
  uncommitted: number;
  patch: string;
  truncated: boolean;
  worktree: boolean;
  branch: string | null;
  baseBranch: string | null;
}

/** POST /commit → `{ result }` (Rust CommitSummary). */
export interface CommitSummary {
  hash?: string;
  files?: string[];
  leftUncommitted?: number;
  skipped?: string[];
  message?: string;
}

/** POST /ship ("Commit & merge"). */
export interface ShipResult {
  committed?: string | null;
  merged?: string | null;
  error?: string | null;
}

export const api = {
  session: (b: Backend) => b.request("GET", "/api/session") as Promise<Session>,
  state: (b: Backend) =>
    b.request("GET", "/api/state") as Promise<StateSnapshot>,
  /** The last `limit` items with seq < `beforeSeq` (oldest first). */
  items: (b: Backend, agentId: string, limit?: number, beforeSeq?: number) => {
    const q = new URLSearchParams();
    if (limit) q.set("limit", String(limit));
    if (beforeSeq !== undefined) q.set("beforeSeq", String(beforeSeq));
    const qs = q.toString();
    return b.request(
      "GET",
      agentPath(agentId, `/items${qs ? `?${qs}` : ""}`),
    ) as Promise<TimelineItem[]>;
  },
  /** Every pending approval across visible agents (cheaper than timelines for the inbox). */
  permissions: (b: Backend) =>
    b.request("GET", "/api/permissions") as Promise<TimelineItem[]>,
  createAgent: (
    b: Backend,
    req: CreateAgentRequest,
    key: string,
    onProgress?: (f: number) => void,
  ) =>
    requestIdempotent(
      b,
      "POST",
      "/api/agents",
      req,
      key,
      onProgress,
    ) as Promise<Agent>,
  prompt: (
    b: Backend,
    agentId: string,
    text: string,
    attachments: Attachment[],
    key: string,
    onProgress?: (f: number) => void,
  ) =>
    requestIdempotent(
      b,
      "POST",
      agentPath(agentId, "/prompt"),
      attachments.length ? { text, attachments } : { text },
      key,
      onProgress,
    ) as Promise<void>,
  permission: (
    b: Backend,
    agentId: string,
    requestId: string,
    optionId: string,
    keepalive = false,
  ) =>
    b.request(
      "POST",
      agentPath(agentId, "/permission"),
      { requestId, optionId },
      { keepalive },
    ) as Promise<void>,
  cancel: (b: Backend, agentId: string) =>
    b.request("POST", agentPath(agentId, "/cancel")) as Promise<void>,
  resume: (b: Backend, agentId: string) =>
    b.request("POST", agentPath(agentId, "/resume")) as Promise<void>,
  stop: (b: Backend, agentId: string) =>
    b.request("POST", agentPath(agentId, "/stop")) as Promise<void>,
  config: (b: Backend, agentId: string, optionId: string, value: string) =>
    b.request("POST", agentPath(agentId, "/config"), {
      optionId,
      value,
    }) as Promise<void>,
  switchAccount: (b: Backend, agentId: string, accountId: string) =>
    b.request("POST", agentPath(agentId, "/account"), {
      accountId,
    }) as Promise<Agent>,
  archive: (b: Backend, agentId: string, archived: boolean) =>
    b.request("POST", agentPath(agentId, "/archive"), {
      archived,
    }) as Promise<void>,
  markRead: (b: Backend, agentId: string) =>
    b.request("POST", agentPath(agentId, "/read")) as Promise<void>,
  removeQueued: (b: Backend, agentId: string, qid: string) =>
    b.request(
      "DELETE",
      agentPath(agentId, `/queue/${encodeURIComponent(qid)}`),
    ) as Promise<
      { text: string | null; attachments?: Attachment[] } | undefined
    >,
  /** Unpause the queue (runs its head if the agent is idle). */
  resumeQueue: (b: Backend, agentId: string) =>
    b.request("POST", agentPath(agentId, "/queue/resume")) as Promise<void>,
  clearQueue: (b: Backend, agentId: string) =>
    b.request("DELETE", agentPath(agentId, "/queue")) as Promise<
      { removed?: number } | undefined
    >,
  /** Into the running turn when the agent can take it; `interrupt` stops the turn and runs it next. */
  sendQueuedNow: (b: Backend, agentId: string, qid: string, interrupt = false) =>
    b.request(
      "POST",
      agentPath(agentId, `/queue/${encodeURIComponent(qid)}/send${interrupt ? "?interrupt=true" : ""}`),
    ) as Promise<void>,
  // Git work (a big diff, commit hooks, a merge) can take well over 15 s.
  diff: (b: Backend, agentId: string) =>
    b.request("GET", agentPath(agentId, "/diff"), undefined, { timeoutMs: GIT_TIMEOUT_MS }) as Promise<AgentDiffSummary>,
  commit: (b: Backend, agentId: string, message: string) =>
    b.request("POST", agentPath(agentId, "/commit"), { message }, { timeoutMs: GIT_TIMEOUT_MS }) as Promise<
      { result?: CommitSummary | string } | undefined
    >,
  ship: (b: Backend, agentId: string, message: string) =>
    b.request("POST", agentPath(agentId, "/ship"), { message }, { timeoutMs: GIT_TIMEOUT_MS }) as Promise<
      ShipResult | undefined
    >,
  image: (b: Backend, agentId: string, path: string) =>
    b.request(
      "GET",
      agentPath(agentId, `/image?path=${encodeURIComponent(path)}`),
    ) as Promise<Attachment>,
};

const REQUEST_TIMEOUT_MS = 15_000;
/** Commit (pre-commit hooks), merge and large diffs. */
const GIT_TIMEOUT_MS = 180_000;
/** Just under the server's 150 s upload deadline, so the client reports it first. */
const UPLOAD_TIMEOUT_MS = 140_000;
/** How long to wait for the event stream's response headers. */
const STREAM_HEADERS_TIMEOUT_MS = 12_000;

function parseErrorBody(text: string): string | null {
  try {
    const body: unknown = JSON.parse(text);
    if (
      body &&
      typeof body === "object" &&
      typeof (body as { error?: unknown }).error === "string"
    )
      return (body as { error: string }).error;
  } catch {
    // Non-JSON error body (proxy, captive portal, ...)
  }
  return null;
}

function parseOk(status: number, text: string): unknown {
  if (status === 204 || !text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(
      502,
      null,
      "Armada sent a response this app couldn't read.",
    );
  }
}

/**
 * Trade a one-time pairing code for this device's own token. Unauthenticated (the code is the
 * credential), so it bypasses the bearer-token backend.
 */
export async function pairDevice(
  code: string,
  deviceName: string,
): Promise<{ token: string; scope: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch("/api/pair", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ code, deviceName }),
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
  } catch {
    throw controller.signal.aborted
      ? new ApiError(408, null)
      : new ApiError(0, null);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new ApiError(res.status, parseErrorBody(text));
  const out = parseOk(res.status, text) as {
    token?: unknown;
    scope?: unknown;
  } | null;
  if (!out || typeof out.token !== "string" || typeof out.scope !== "string") {
    throw new ApiError(
      502,
      null,
      "Armada sent a response this app couldn't read.",
    );
  }
  return { token: out.token, scope: out.scope };
}

/** Real server: bearer-token auth, JSON in/out, SSE over a streaming fetch. */
export class HttpBackend implements Backend {
  readonly kind = "http" as const;
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  async request(
    method: HttpMethod,
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
  ): Promise<unknown> {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    if (encoded !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    const large = encoded !== undefined && encoded.length > 256 * 1024;
    // Photo uploads over a phone's Wi-Fi can take a while; XHR reports progress.
    if (large || opts.onProgress)
      return this.xhr(
        method,
        path,
        headers,
        encoded,
        large ? UPLOAD_TIMEOUT_MS : (opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
        opts.onProgress,
      );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: encoded,
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
        keepalive: opts.keepalive,
      });
    } catch {
      throw controller.signal.aborted
        ? new ApiError(408, null)
        : new ApiError(0, null);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new ApiError(res.status, parseErrorBody(text));
    return parseOk(res.status, text);
  }

  private xhr(
    method: HttpMethod,
    path: string,
    headers: Record<string, string>,
    body: string | undefined,
    timeout: number,
    onProgress?: (fraction: number) => void,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open(method, path);
      for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
      x.timeout = timeout;
      if (onProgress) {
        x.upload.onprogress = (e) => {
          if (e.lengthComputable && e.total > 0)
            onProgress(Math.min(1, e.loaded / e.total));
        };
      }
      x.onload = () => {
        if (x.status >= 200 && x.status < 300) {
          try {
            resolve(parseOk(x.status, x.responseText));
          } catch (e) {
            reject(e);
          }
        } else reject(new ApiError(x.status, parseErrorBody(x.responseText)));
      };
      x.onerror = () => reject(new ApiError(0, null));
      x.ontimeout = () =>
        reject(
          new ApiError(
            408,
            null,
            "The upload took too long. Try again on a stronger connection.",
          ),
        );
      x.send(body ?? null);
    });
  }

  /**
   * SSE via fetch rather than EventSource: the token goes in a header (never
   * the URL), we get the HTTP status (so a revoked token is detected instead
   * of retried forever), and we see heartbeat comments, which lets the caller
   * run a stall watchdog.
   */
  async stream({
    signal,
    onOpen,
    onMessage,
    onActivity,
  }: StreamHandlers): Promise<void> {
    // Our own controller so a server that accepts the connection but never
    // sends headers can't hang the reconnect loop.
    const controller = new AbortController();
    const forward = () => controller.abort();
    signal.addEventListener("abort", forward, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, STREAM_HEADERS_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await fetch("/api/events", {
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${this.token}`,
          },
          cache: "no-store",
          credentials: "omit",
          signal: controller.signal,
        });
      } catch (e) {
        if (signal.aborted) throw e;
        throw timedOut ? new ApiError(408, null) : new ApiError(0, null);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok)
        throw new ApiError(
          res.status,
          parseErrorBody(await res.text().catch(() => "")),
        );
      if (!res.body)
        throw new ApiError(0, null, "This browser can't stream live updates.");
      onOpen();

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      const parser = new SseParser(onMessage);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          onActivity();
          parser.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    } finally {
      signal.removeEventListener("abort", forward);
    }
  }
}

/** Minimal `text/event-stream` parser: only `data:` fields matter here. */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private readonly emit: (data: string) => void;

  constructor(emit: (data: string) => void) {
    this.emit = emit;
  }

  push(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.line(line);
    }
  }

  private line(line: string) {
    if (line === "") {
      if (this.data.length) {
        const payload = this.data.join("\n");
        this.data = [];
        this.emit(payload);
      }
      return;
    }
    if (line.startsWith(":")) return; // comment / heartbeat
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
  }
}
