import type { KeyValue, McpServer } from "@/lib/types";

export type PastedServer = Omit<McpServer, "id" | "enabled">;

export interface PasteResult {
  servers: PastedServer[];
  /** Entries we couldn't interpret, with the reason. */
  skipped: { name: string; reason: string }[];
  /** A single nameless server object was pasted; the user has to name it. */
  needsName: boolean;
  /** Imported, but worth a look (SSE transport, ${VAR} placeholders). */
  warnings: { name: string; message: string }[];
}

export class PasteError extends Error {}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

const isObject = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** Turn a JSON.parse error into "line L, column C: …" when the engine reports a position. */
function describeJsonError(text: string, e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // Older engines append "in JSON at position N"; newer V8 quotes the whole input instead.
  const msg = raw.replace(/\s*in JSON at position \d+/i, "").replace(/,\s*"[\s\S]*" is not valid JSON$/, "");
  const lc = /line (\d+) column (\d+)/i.exec(msg);
  if (lc) return `Invalid JSON at line ${lc[1]}, column ${lc[2]}: ${msg.replace(/\s*\(line \d+ column \d+\)/i, "")}`;
  const pos = /position (\d+)/i.exec(raw);
  const found = pos ? Number(pos[1]) : jsonErrorOffset(text);
  if (found >= 0) {
    const at = found;
    const before = text.slice(0, at);
    const line = before.split("\n").length;
    const col = at - before.lastIndexOf("\n");
    return `Invalid JSON at line ${line}, column ${col}: ${msg}`;
  }
  return `Invalid JSON: ${msg}`;
}

function toKeyValues(v: Json | undefined): KeyValue[] {
  if (!isObject(v)) return [];
  return Object.entries(v)
    .filter(([name]) => name.trim())
    .map(([name, value]) => ({ name, value: value === null ? "" : String(value) }));
}

const HTTP_TYPES = new Set(["http", "sse", "streamable-http", "streamablehttp", "streamable_http"]);

function looksLikeServer(v: Json | undefined): v is JsonObject {
  return isObject(v) && (typeof v.command === "string" || typeof v.url === "string" || typeof v.serverUrl === "string");
}

const SSE_WARNING = "Armada supports stdio and Streamable HTTP; SSE-only servers may not work.";
const VAR_RE = /\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*/;

/** Warnings for a converted server: SSE transport and unexpanded ${VAR} references. */
function warningsFor(server: PastedServer, sse: boolean): string[] {
  const out: string[] = [];
  if (sse) out.push(SSE_WARNING);
  const values = [
    server.command,
    server.url,
    ...server.args,
    ...server.env.map((kv) => kv.value),
    ...server.headers.map((kv) => kv.value),
  ];
  const vars = new Set<string>();
  for (const v of values) for (const m of v.matchAll(new RegExp(VAR_RE, "g"))) vars.add(m[0]);
  if (vars.size) {
    out.push(
      `${[...vars].join(", ")} ${vars.size === 1 ? "is" : "are"} passed literally (not expanded); replace with the real value if needed.`,
    );
  }
  return out;
}

function convert(name: string, v: JsonObject): PastedServer | string {
  const type = typeof v.type === "string" ? v.type.toLowerCase() : null;
  const url = typeof v.url === "string" ? v.url : typeof v.serverUrl === "string" ? v.serverUrl : null;
  if (url && (type === null || HTTP_TYPES.has(type))) {
    return {
      name,
      transport: "http",
      command: "",
      args: [],
      env: [],
      url: url.trim(),
      headers: toKeyValues(v.headers),
    };
  }
  if (typeof v.command === "string" && v.command.trim()) {
    const args = Array.isArray(v.args) ? v.args.map((a) => String(a)) : [];
    return { name, transport: "stdio", command: v.command.trim(), args, env: toKeyValues(v.env), url: "", headers: [] };
  }
  if (type && !HTTP_TYPES.has(type) && type !== "stdio") return `Unsupported transport “${type}”`;
  return "Needs a “command” (local) or “url” (remote)";
}

/**
 * Make JSON-with-comments parseable: drop // and /* *\/ comments and trailing commas,
 * only outside strings (so URLs like "https://…" survive).
 */
export function stripJsonc(text: string): string {
  return dropTrailingCommas(dropComments(text));
}

/** Walk `text` outside of JSON strings, letting `visit` decide what to emit for each char. */
function scanOutsideStrings(text: string, visit: (i: number) => { out: string; skip: number }): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    const r = visit(i);
    out += r.out;
    i += r.skip;
  }
  return out;
}

function dropComments(text: string): string {
  return scanOutsideStrings(text, (i) => {
    if (text[i] === "/" && text[i + 1] === "/") {
      let end = text.indexOf("\n", i);
      if (end < 0) end = text.length;
      return { out: " ".repeat(end - i), skip: end - i - 1 };
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close < 0 ? text.length : close + 2;
      // Same length, newlines kept, so error positions still point at the right place.
      return { out: text.slice(i, end).replace(/[^\n]/g, " "), skip: end - i - 1 };
    }
    return { out: text[i], skip: 0 };
  });
}

function dropTrailingCommas(text: string): string {
  return scanOutsideStrings(text, (i) => {
    if (text[i] !== ",") return { out: text[i], skip: 0 };
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    return { out: text[j] === "}" || text[j] === "]" ? " " : ",", skip: 0 };
  });
}

/**
 * Offset of the first JSON syntax error (engines differ on whether JSON.parse reports one,
 * e.g. recent V8 doesn't), or -1 when the text is valid.
 */
export function jsonErrorOffset(text: string): number {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const fail = (): never => {
    throw i;
  };
  const str = () => {
    if (text[i] !== '"') fail();
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") i++;
      else if (text[i] === "\n") fail();
      i++;
    }
    if (text[i] !== '"') fail();
    i++;
  };
  const value = (): void => {
    ws();
    const ch = text[i];
    if (ch === "{") {
      i++;
      ws();
      if (text[i] === "}") return void i++;
      for (;;) {
        ws();
        str();
        ws();
        if (text[i] !== ":") fail();
        i++;
        value();
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "}") return void i++;
        else fail();
      }
    }
    if (ch === "[") {
      i++;
      ws();
      if (text[i] === "]") return void i++;
      for (;;) {
        value();
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "]") return void i++;
        else fail();
      }
    }
    if (ch === '"') return str();
    const lit = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!lit) fail();
    i += lit![0].length;
  };
  try {
    value();
    ws();
    return i < text.length ? i : -1;
  } catch (at) {
    return typeof at === "number" ? at : -1;
  }
}

/** Split a shell command line into words (single/double quotes, backslash escapes, line continuations). */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  const src = line.replace(/\\\r?\n/g, " ");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < src.length) cur += src[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < src.length) {
      cur += src[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) words.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) throw new PasteError("Unterminated quote in the command line.");
  if (has) words.push(cur);
  return words;
}

/**
 * `claude mcp add [--transport http|sse|stdio] [-e K=V]… [-H "K: V"]… [-s scope] <name> <url|command> [args…]`
 * (options may appear anywhere before `--`; everything after `--` is the command and its args),
 * and `claude mcp add-json <name> '<json>'`.
 */
function parseClaudeAdd(words: string[]): { name: string; server: PastedServer; sse: boolean } | string {
  const sub = words[2];
  if (sub === "add-json") {
    const [name, json] = words.slice(3).filter((w) => !/^(-s|--scope)$/.test(w));
    if (!name || !json) return "add-json needs a name and a JSON server object";
    let v: Json;
    try {
      v = JSON.parse(stripJsonc(json)) as Json;
    } catch (e) {
      return describeJsonError(stripJsonc(json), e);
    }
    if (!isObject(v)) return "add-json expects a JSON object";
    const r = convert(name, v);
    if (typeof r === "string") return r;
    return { name, server: r, sse: typeof v.type === "string" && v.type.toLowerCase() === "sse" };
  }
  let transport = "stdio";
  const env: KeyValue[] = [];
  const headers: KeyValue[] = [];
  const pos: string[] = [];
  const rest = words.slice(3);
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (w === "--") {
      pos.push(...rest.slice(i + 1));
      break;
    }
    const takes = (flags: string[]) =>
      flags.includes(w) || flags.some((f) => f.startsWith("--") && w.startsWith(`${f}=`));
    const value = () => (w.includes("=") && w.startsWith("--") ? w.slice(w.indexOf("=") + 1) : (rest[++i] ?? ""));
    if (takes(["-t", "--transport"])) transport = value().toLowerCase();
    else if (takes(["-e", "--env"])) {
      const kv = value();
      const eq = kv.indexOf("=");
      if (eq > 0) env.push({ name: kv.slice(0, eq), value: kv.slice(eq + 1) });
    } else if (takes(["-H", "--header"])) {
      const kv = value();
      const colon = kv.indexOf(":");
      if (colon > 0) headers.push({ name: kv.slice(0, colon).trim(), value: kv.slice(colon + 1).trim() });
    } else if (takes(["-s", "--scope"])) value();
    else if (w.startsWith("-") && pos.length < 2) return `Unknown option “${w}”`;
    else pos.push(w);
  }
  const [name, target, ...args] = pos;
  if (!name || !target) return "Expected “claude mcp add <name> <url-or-command> [args…]”";
  if (transport === "http" || transport === "sse" || /^https?:\/\//.test(target)) {
    return {
      name,
      sse: transport === "sse",
      server: { name, transport: "http", command: "", args: [], env: [], url: target, headers },
    };
  }
  if (transport !== "stdio") return `Unsupported transport “${transport}”`;
  return { name, sse: false, server: { name, transport: "stdio", command: target, args, env, url: "", headers: [] } };
}

/** Lines that start a `claude mcp add` / `add-json` command (with optional `$ ` prompt). */
const CLAUDE_ADD = /^\s*(?:\$\s*)?claude\s+mcp\s+add(?:-json)?\b/;

/**
 * Accepts the common MCP config shapes:
 * `{"mcpServers": {name: server}}`, `{"servers": {...}}`, `{name: server}`, `[server…]`, or one server object.
 */
export function parseMcpConfig(text: string): PasteResult {
  const trimmed = text.trim();
  if (!trimmed) throw new PasteError("Paste a JSON snippet or a `claude mcp add` command to import.");

  const servers: PastedServer[] = [];
  const skipped: PasteResult["skipped"] = [];
  const warnings: PasteResult["warnings"] = [];
  const accept = (server: PastedServer, sse: boolean) => {
    servers.push(server);
    for (const message of warningsFor(server, sse)) warnings.push({ name: server.name, message });
  };

  // One or more `claude mcp add …` command lines (with \ continuations).
  if (CLAUDE_ADD.test(trimmed)) {
    const commands = trimmed
      .replace(/\\\r?\n/g, " ")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const cmd of commands) {
      if (!CLAUDE_ADD.test(cmd)) {
        skipped.push({ name: cmd.slice(0, 40), reason: "Not a `claude mcp add` command" });
        continue;
      }
      const words = shellWords(cmd.replace(/^\s*\$\s*/, ""));
      const r = parseClaudeAdd(words);
      if (typeof r === "string") skipped.push({ name: words[3] ?? "", reason: r });
      else accept(r.server, r.sse);
    }
    return { servers, skipped, needsName: false, warnings };
  }

  let root: Json;
  try {
    root = JSON.parse(stripJsonc(trimmed)) as Json;
  } catch (e) {
    // Report positions against the comment-free text (same length and line breaks as the input).
    throw new PasteError(describeJsonError(stripJsonc(trimmed), e));
  }

  const add = (name: string, v: Json | undefined) => {
    if (!isObject(v)) {
      skipped.push({ name, reason: "Not an object" });
      return;
    }
    const r = convert(name, v);
    if (typeof r === "string") skipped.push({ name, reason: r });
    else accept(r, typeof v.type === "string" && v.type.toLowerCase() === "sse");
  };

  if (Array.isArray(root)) {
    root.forEach((v, i) => {
      const name = isObject(v) && typeof v.name === "string" && v.name.trim() ? v.name.trim() : `server-${i + 1}`;
      add(name, v);
    });
    return { servers, skipped, needsName: false, warnings };
  }
  if (!isObject(root)) throw new PasteError("Expected a JSON object or array.");

  const map = isObject(root.mcpServers) ? root.mcpServers : isObject(root.servers) ? root.servers : null;
  if (map) {
    for (const [name, v] of Object.entries(map)) add(name, v);
    return { servers, skipped, needsName: false, warnings };
  }
  if (looksLikeServer(root)) {
    const name = typeof root.name === "string" ? root.name.trim() : "";
    add(name, root);
    return { servers, skipped, needsName: !name, warnings };
  }
  // A bare name → server map.
  const entries = Object.entries(root) as [string, Json][];
  if (entries.length > 0 && entries.every(([, v]) => looksLikeServer(v))) {
    for (const [name, v] of entries) add(name, v);
    return { servers, skipped, needsName: false, warnings };
  }
  throw new PasteError(
    "Couldn't find any servers. Expected “mcpServers”, a server map, a server object, or `claude mcp add …`.",
  );
}
