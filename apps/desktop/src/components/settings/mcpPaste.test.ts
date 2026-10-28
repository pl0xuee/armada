import { describe, expect, it } from "vitest";
import { parseMcpConfig, PasteError, shellWords, stripJsonc } from "./mcpPaste";

describe("parseMcpConfig: JSON shapes", () => {
  it("reads an mcpServers map with stdio and http servers", () => {
    const r = parseMcpConfig(`{
      "mcpServers": {
        "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], "env": { "DEBUG": "1" } },
        "gh": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer x" } }
      }
    }`);
    expect(r.servers).toHaveLength(2);
    expect(r.servers[0]).toMatchObject({ name: "fs", transport: "stdio", command: "npx" });
    expect(r.servers[0].env).toEqual([{ name: "DEBUG", value: "1" }]);
    expect(r.servers[1]).toMatchObject({ name: "gh", transport: "http", url: "https://api.githubcopilot.com/mcp/" });
    expect(r.warnings).toEqual([]);
  });

  it("accepts comments and trailing commas without touching strings", () => {
    const r = parseMcpConfig(`{
      // my servers
      "mcpServers": {
        /* remote */ "docs": { "url": "https://example.com/mcp//x", }, // trailing
      },
    }`);
    expect(r.servers[0]).toMatchObject({ name: "docs", url: "https://example.com/mcp//x" });
  });

  it("warns about SSE and ${VAR} references", () => {
    const r = parseMcpConfig(
      `{"mcpServers":{"s":{"type":"sse","url":"https://x/sse","headers":{"Authorization":"Bearer \${TOKEN}"}}}}`,
    );
    expect(r.servers[0].transport).toBe("http");
    const msgs = r.warnings.map((w) => w.message).join(" | ");
    expect(msgs).toContain("SSE-only servers may not work");
    expect(msgs).toContain("${TOKEN}");
  });

  it("asks for a name for a single nameless server object", () => {
    const r = parseMcpConfig(`{"command":"uvx","args":["mcp-server-time"]}`);
    expect(r.needsName).toBe(true);
    expect(r.servers[0].command).toBe("uvx");
  });

  it("skips entries it can't interpret", () => {
    const r = parseMcpConfig(`{"mcpServers":{"bad":{"foo":1},"ok":{"command":"node"}}}`);
    expect(r.servers.map((s) => s.name)).toEqual(["ok"]);
    expect(r.skipped[0].name).toBe("bad");
  });

  it("reports JSON errors with a line and column", () => {
    expect(() => parseMcpConfig(`{\n  "mcpServers": {\n    "x": oops\n  }\n}`)).toThrow(PasteError);
    try {
      parseMcpConfig(`{\n  "a": oops\n}`);
    } catch (e) {
      const msg = String((e as Error).message);
      expect(msg).toMatch(/line 2, column 8/);
      expect(msg).not.toContain("is not valid JSON");
    }
  });
});

describe("parseMcpConfig: claude mcp add", () => {
  it("parses stdio servers with env and -- separated args", () => {
    const r = parseMcpConfig(
      `claude mcp add my-db -e PGHOST=localhost -e "PGPASS=s3 cret" -- npx -y @mcp/postgres --ro`,
    );
    expect(r.servers[0]).toMatchObject({
      name: "my-db",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@mcp/postgres", "--ro"],
    });
    expect(r.servers[0].env).toEqual([
      { name: "PGHOST", value: "localhost" },
      { name: "PGPASS", value: "s3 cret" },
    ]);
  });

  it("parses http servers with headers, multiple lines and a $ prompt", () => {
    const r =
      parseMcpConfig(`$ claude mcp add --transport http -H "Authorization: Bearer abc" sentry https://mcp.sentry.dev/mcp
claude mcp add --transport sse linear https://mcp.linear.app/sse`);
    expect(r.servers.map((s) => s.name)).toEqual(["sentry", "linear"]);
    expect(r.servers[0].headers).toEqual([{ name: "Authorization", value: "Bearer abc" }]);
    expect(r.warnings.some((w) => w.name === "linear" && /SSE/.test(w.message))).toBe(true);
  });

  it("supports line continuations and add-json", () => {
    const r = parseMcpConfig(`claude mcp add-json weather '{"type":"stdio","command":"uvx","args":["weather-mcp"]}'`);
    expect(r.servers[0]).toMatchObject({ name: "weather", command: "uvx", args: ["weather-mcp"] });
    const c = parseMcpConfig("claude mcp add notes \\\n  -- node server.js");
    expect(c.servers[0]).toMatchObject({ name: "notes", command: "node", args: ["server.js"] });
  });

  it("skips malformed commands with a reason", () => {
    const r = parseMcpConfig("claude mcp add only-a-name");
    expect(r.servers).toHaveLength(0);
    expect(r.skipped[0].reason).toMatch(/Expected/);
  });
});

describe("helpers", () => {
  it("stripJsonc keeps // inside strings", () => {
    expect(JSON.parse(stripJsonc(`{"u":"http://a//b", /* c */ "n":1,}`))).toEqual({ u: "http://a//b", n: 1 });
  });
  it("shellWords handles quotes and escapes", () => {
    expect(shellWords(`a "b c" 'd e' f\\ g`)).toEqual(["a", "b c", "d e", "f g"]);
    expect(() => shellWords(`a "b`)).toThrow();
  });
});
