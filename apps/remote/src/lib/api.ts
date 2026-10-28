import type { Session, StateSnapshot, TimelineItem } from "./types";

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

function describeStatus(status: number, serverMessage: string | null): string {
  switch (status) {
    case 0:
      return "Can't reach Armada. Check that your computer is awake and reachable.";
    case 401:
      return "This device was unpaired.";
    case 403:
      return "This link is read-only.";
    case 404:
      return serverMessage ?? "That agent no longer exists.";
    case 408:
      return "Armada took too long to respond.";
    case 429:
      return "Too many attempts. Try again in a few minutes.";
    default:
      if (status >= 500) return serverMessage ? `Armada hit an error: ${serverMessage}` : "Armada hit an error. Try again.";
      return serverMessage ?? `Request failed (${status}).`;
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
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

/**
 * Everything the app needs from the server. Implemented over HTTP for real use
 * and in memory by the dev mock, so the UI can't tell them apart.
 */
export interface Backend {
  readonly kind: "http" | "mock";
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
  /** Resolves when the server ends the stream; rejects on failure (ApiError for HTTP statuses). */
  stream(handlers: StreamHandlers): Promise<void>;
}

export const api = {
  session: (b: Backend) => b.request("GET", "/api/session") as Promise<Session>,
  state: (b: Backend) => b.request("GET", "/api/state") as Promise<StateSnapshot>,
  items: (b: Backend, agentId: string) =>
    b.request("GET", `/api/agents/${encodeURIComponent(agentId)}/items`) as Promise<TimelineItem[]>,
  prompt: (b: Backend, agentId: string, text: string) =>
    b.request("POST", `/api/agents/${encodeURIComponent(agentId)}/prompt`, { text }) as Promise<void>,
  permission: (b: Backend, agentId: string, requestId: string, optionId: string) =>
    b.request("POST", `/api/agents/${encodeURIComponent(agentId)}/permission`, { requestId, optionId }) as Promise<void>,
  cancel: (b: Backend, agentId: string) =>
    b.request("POST", `/api/agents/${encodeURIComponent(agentId)}/cancel`) as Promise<void>,
  resume: (b: Backend, agentId: string) =>
    b.request("POST", `/api/agents/${encodeURIComponent(agentId)}/resume`) as Promise<void>,
};

const REQUEST_TIMEOUT_MS = 15_000;

async function readError(res: Response): Promise<ApiError> {
  let message: string | null = null;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
      message = (body as { error: string }).error;
    }
  } catch {
    // Non-JSON error body (proxy, captive portal, ...): fall back to the status text.
  }
  return new ApiError(res.status, message);
}

/** Real server: bearer-token auth, JSON in/out, SSE over a streaming fetch. */
export class HttpBackend implements Backend {
  readonly kind = "http" as const;
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      });
    } catch {
      throw controller.signal.aborted ? new ApiError(408, null) : new ApiError(0, null);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw await readError(res);
    if (res.status === 204) return undefined;
    const text = await res.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ApiError(502, null, "Armada sent a response this app couldn't read.");
    }
  }

  /**
   * SSE via fetch rather than EventSource: we get the HTTP status (so a revoked
   * token is detected instead of silently retried forever) and we see heartbeat
   * comments, which lets the caller run a stall watchdog.
   */
  async stream({ signal, onOpen, onMessage, onActivity }: StreamHandlers): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`/api/events?token=${encodeURIComponent(this.token)}`, {
        headers: { Accept: "text/event-stream", Authorization: `Bearer ${this.token}` },
        cache: "no-store",
        credentials: "omit",
        signal,
      });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new ApiError(0, null);
    }
    if (!res.ok) throw await readError(res);
    if (!res.body) throw new ApiError(0, null, "This browser can't stream live updates.");
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
