import { describe, expect, it } from "vitest";
import { guessAlertKind, maskAlertUrl, newAlertTarget, validateAlertUrl } from "./alertTargets";

describe("validateAlertUrl", () => {
  it("accepts the shapes each service uses", () => {
    expect(validateAlertUrl("slack", "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX")).toBeNull();
    expect(validateAlertUrl("discord", "https://discord.com/api/webhooks/123456/abcdef-token")).toBeNull();
    expect(validateAlertUrl("discord", "https://canary.discord.com/api/webhooks/1/2")).toBeNull();
    expect(validateAlertUrl("webhook", "https://example.com/hooks/abc?token=1")).toBeNull();
  });

  it("allows plain http only to localhost, only for a generic webhook", () => {
    expect(validateAlertUrl("webhook", "http://localhost:8080/hook")).toBeNull();
    expect(validateAlertUrl("webhook", "http://127.0.0.1:9000/")).toBeNull();
    expect(validateAlertUrl("webhook", "http://[::1]:9000/")).toBeNull();
    expect(validateAlertUrl("webhook", "http://example.com/hook")).toMatch(/https/);
    expect(validateAlertUrl("webhook", "http://192.168.1.5/hook")).toMatch(/https/);
    expect(validateAlertUrl("slack", "http://localhost/services/T000/B000/XXXXXXXXXXXX")).toMatch(/https/);
  });

  it("rejects look-alike hosts, credentials and other schemes", () => {
    expect(validateAlertUrl("slack", "https://hooks.slack.com.evil.com/services/T000/B000/XXXXXX")).toMatch(/Slack/);
    expect(validateAlertUrl("slack", "https://example.com/services/T000/B000/XXXXXXXXXXXX")).toMatch(/Slack/);
    expect(validateAlertUrl("slack", "https://hooks.slack.com/")).toMatch(/Slack/);
    expect(validateAlertUrl("discord", "https://discord.com.evil.io/api/webhooks/1/2")).toMatch(/Discord/);
    expect(validateAlertUrl("discord", "https://discord.com/api/webhooks/123")).toMatch(/Discord/);
    expect(validateAlertUrl("webhook", "https://user:pw@example.com/hook")).toMatch(/user name/);
    expect(validateAlertUrl("webhook", "ftp://example.com/hook")).toMatch(/https/);
    expect(validateAlertUrl("webhook", "javascript:alert(1)")).not.toBeNull();
    expect(validateAlertUrl("webhook", "not a url")).toMatch(/valid/);
    expect(validateAlertUrl("webhook", "  ")).toMatch(/Enter/);
    expect(validateAlertUrl("webhook", `https://a.com/${"x".repeat(3000)}`)).toMatch(/long/);
  });
});

describe("maskAlertUrl", () => {
  it("keeps the server and hides the secret", () => {
    const masked = maskAlertUrl("https://hooks.slack.com/services/T000/B000/SECRETSECRET1234");
    expect(masked).toBe("https://hooks.slack.com/…••••••");
    expect(masked).not.toContain("SECRET");
    expect(masked).not.toContain("services");
  });
  it("never echoes junk", () => {
    expect(maskAlertUrl("hunter2")).toBe("••••••••");
  });
});

describe("newAlertTarget / guessAlertKind", () => {
  it("starts with the events people usually want", () => {
    const t = newAlertTarget("discord", " https://discord.com/api/webhooks/1/2 ", "  Ops ");
    expect(t).toMatchObject({
      kind: "discord",
      url: "https://discord.com/api/webhooks/1/2",
      name: "Ops",
      enabled: true,
      events: { needsYou: true, finished: false, failed: true, budget: true },
    });
    expect(t.id).toMatch(/^alert-/);
    expect(newAlertTarget("slack", "x", "").id).not.toBe(t.id);
  });
  it("recognizes the services by host", () => {
    expect(guessAlertKind("https://hooks.slack.com/services/a/b/c")).toBe("slack");
    expect(guessAlertKind("https://discord.com/api/webhooks/1/2")).toBe("discord");
    expect(guessAlertKind("https://example.com/x")).toBeNull();
    expect(guessAlertKind("nope")).toBeNull();
  });
});
