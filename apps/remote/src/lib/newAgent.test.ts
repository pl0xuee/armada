import { beforeEach, describe, expect, it } from "vitest";
import { accountProblem, agentChoices, initialForm, looksLikePath, saveLast, validate, type NewAgentForm } from "./newAgent";
import type { RemoteAccount, RemoteCustomAgent } from "./types";

const acc = (id: string, provider: RemoteAccount["provider"]): RemoteAccount => ({ id, name: id, provider, color: "#4FC3F7", label: null });
const accounts = [acc("c1", "claude"), acc("c2", "claude"), acc("x1", "codex"), acc("k1", "custom")];
const customs: RemoteCustomAgent[] = [
  { id: "gemini", name: "Gemini CLI", color: "#8AB4F8", enabled: true },
  { id: "goose", name: "Goose", color: "not-a-color", enabled: true },
  { id: "off", name: "Disabled", color: "#fff", enabled: false },
];

beforeEach(() => localStorage.clear());

describe("agentChoices", () => {
  it("lists providers with accounts and enabled custom agents by name/color", () => {
    const c = agentChoices(accounts, customs);
    expect(c.map((x) => x.key)).toEqual(["claude", "codex", "custom:gemini", "custom:goose"]);
    expect(c.find((x) => x.key === "claude")?.accounts.map((a) => a.id)).toEqual(["c1", "c2"]);
    expect(c.find((x) => x.key === "custom:gemini")).toMatchObject({ name: "Gemini CLI", color: "#8AB4F8", customAgentId: "gemini" });
    // Invalid colors fall back to the custom-agent color.
    expect(c.find((x) => x.key === "custom:goose")?.color).toBe("#B39DDB");
  });
  it("hides custom agents when there's no custom account", () => {
    expect(agentChoices(accounts.filter((a) => a.provider !== "custom"), customs).map((x) => x.key)).toEqual(["claude", "codex"]);
  });
});

describe("validate", () => {
  const choices = agentChoices(accounts, customs);
  const base: NewAgentForm = { choiceKey: "claude", accountId: "c2", projectPath: " /home/me/app ", worktree: true, title: "", prompt: "", attachments: [], model: "", permissionMode: null };

  it("builds a minimal request (prompt optional)", () => {
    expect(validate(base, choices)).toEqual({
      ok: true,
      request: { provider: "claude", accountId: "c2", projectPath: "/home/me/app", worktree: true },
    });
  });
  it("passes customAgentId for custom agents", () => {
    const r = validate({ ...base, choiceKey: "custom:gemini", accountId: "k1", prompt: " hi ", title: " T " }, choices);
    expect(r).toEqual({
      ok: true,
      request: { provider: "custom", accountId: "k1", projectPath: "/home/me/app", worktree: true, customAgentId: "gemini", prompt: "hi", title: "T" },
    });
  });
  it("rejects an account of another provider", () => {
    expect(validate({ ...base, accountId: "x1" }, choices)).toMatchObject({ ok: false, field: "account" });
  });
  it("requires a full folder path", () => {
    expect(validate({ ...base, projectPath: "" }, choices)).toMatchObject({ ok: false, field: "folder" });
    expect(validate({ ...base, projectPath: "code/app" }, choices)).toMatchObject({ ok: false, field: "folder" });
    expect(looksLikePath("C:\\\\Users\\\\me")).toBe(true);
    expect(looksLikePath("~/code")).toBe(true);
  });
  it("passes an optional model id, trimmed", () => {
    expect(validate({ ...base, model: " claude-opus-4 " }, choices)).toMatchObject({ ok: true, request: { model: "claude-opus-4" } });
    expect(validate({ ...base, model: "  " }, choices)).toMatchObject({ ok: true, request: expect.not.objectContaining({ model: expect.anything() }) });
  });
  it("passes the permission mode only when offered", () => {
    expect(validate({ ...base, permissionMode: "auto" }, choices)).toMatchObject({ ok: true, request: { permissionMode: "auto" } });
    expect(validate(base, choices)).toMatchObject({ ok: true, request: expect.not.objectContaining({ permissionMode: expect.anything() }) });
  });
  it("requires an agent choice", () => {
    expect(validate({ ...base, choiceKey: "grok" }, choices)).toMatchObject({ ok: false, field: "agent" });
  });
});

describe("initialForm", () => {
  const choices = agentChoices(accounts, customs);
  it("restores the last valid choices", () => {
    saveLast({ choiceKey: "custom:gemini", accountId: "k1", projectPath: "/p/b" });
    expect(initialForm(choices, ["/p/a", "/p/b"], true)).toMatchObject({
      choiceKey: "custom:gemini",
      accountId: "k1",
      projectPath: "/p/b",
      worktree: true,
    });
  });
  it("falls back to defaults when the last choice is gone", () => {
    saveLast({ choiceKey: "grok", accountId: "zz", projectPath: "/gone" });
    expect(initialForm(choices, ["/p/a"], false)).toMatchObject({ choiceKey: "claude", accountId: "c1", projectPath: "/p/a", worktree: false, permissionMode: null });
    expect(initialForm(choices, ["/p/a"], false, {}, "auto").permissionMode).toBe("auto");
  });
});

describe("accountProblem", () => {
  it("warns about signed-out or failing accounts only", () => {
    expect(accountProblem({ loggedIn: false, error: null })).toMatch(/signed out/);
    expect(accountProblem({ loggedIn: true, error: "token expired" })).toMatch(/token expired/);
    expect(accountProblem({ loggedIn: true, error: null })).toBeNull();
    expect(accountProblem({ loggedIn: null })).toBeNull();
    expect(accountProblem(undefined)).toBeNull();
  });
});
