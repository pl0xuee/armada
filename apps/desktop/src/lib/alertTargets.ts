import type { AlertEvents, AlertKind, AlertTarget } from "./types";

export const ALERT_KINDS: { value: AlertKind; label: string; placeholder: string; hint: string }[] = [
  {
    value: "slack",
    label: "Slack",
    placeholder: "https://hooks.slack.com/services/T000/B000/XXXX",
    hint: "In Slack, add the Incoming Webhooks app to a channel and paste its URL.",
  },
  {
    value: "discord",
    label: "Discord",
    placeholder: "https://discord.com/api/webhooks/123/abc",
    hint: "In Discord, open a channel's settings, then Integrations, Webhooks, and copy the URL.",
  },
  {
    value: "webhook",
    label: "Webhook",
    placeholder: "https://example.com/armada-hook",
    hint: "Armada POSTs a small JSON message. https only (http works for localhost).",
  },
];

export const ALERT_EVENTS: { key: keyof AlertEvents; label: string; hint: string }[] = [
  { key: "needsYou", label: "Needs you", hint: "An agent waits for an approval or an answer" },
  { key: "finished", label: "Finished", hint: "An agent finished its work" },
  { key: "failed", label: "Failed", hint: "A turn stopped with an error" },
  { key: "budget", label: "Budget", hint: "A spending limit paused an agent" },
];

export const MAX_ALERT_TARGETS = 8;

export function kindLabel(kind: AlertKind): string {
  return ALERT_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

const DISCORD_HOSTS = ["discord.com", "ptb.discord.com", "canary.discord.com", "discordapp.com"];

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return h === "localhost" || /^127(\.\d{1,3}){3}$/.test(h) || h === "::1";
}

/**
 * Why a webhook URL won't do, or null when it's fine. The same rules as the app's backend,
 * which checks again on save and before every message.
 */
export function validateAlertUrl(kind: AlertKind, raw: string): string | null {
  const text = raw.trim();
  if (!text) return "Enter the webhook URL";
  if (text.length > 2048) return "That URL is too long";
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return "That isn't a valid URL";
  }
  if (u.username || u.password) return "Don't put a user name or password in the URL";
  if (!u.hostname) return "The URL needs a server name";
  const host = u.hostname.toLowerCase();
  if (u.protocol === "http:" && kind === "webhook" && isLoopback(host)) {
    // plain http to this computer is fine
  } else if (u.protocol === "http:" && kind === "webhook") {
    return "Use https:// (plain http is only allowed for localhost)";
  } else if (u.protocol !== "https:") {
    return "The URL must start with https://";
  }
  if (kind === "slack") {
    const ok = ["/services/", "/workflows/", "/triggers/"].some(
      (p) => u.pathname.startsWith(p) && u.pathname.length > p.length + 6,
    );
    if (host !== "hooks.slack.com" || !ok) return "A Slack incoming webhook looks like https://hooks.slack.com/services/…";
  }
  if (kind === "discord") {
    const parts = u.pathname.startsWith("/api/webhooks/")
      ? u.pathname.slice("/api/webhooks/".length).split("/").filter(Boolean).length
      : 0;
    if (!DISCORD_HOSTS.includes(host) || parts < 2) return "A Discord webhook looks like https://discord.com/api/webhooks/…";
  }
  return null;
}

/** The URL with its secret part hidden: only the server is shown. */
export function maskAlertUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    return `${u.protocol}//${u.host}/…••••••`;
  } catch {
    return "••••••••";
  }
}

export function newAlertId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `alert-${rand}`;
}

/** A target as the "add" form first offers it. */
export function newAlertTarget(kind: AlertKind, url: string, name: string): AlertTarget {
  return {
    id: newAlertId(),
    name: name.trim(),
    kind,
    url: url.trim(),
    enabled: true,
    events: { needsYou: true, finished: false, failed: true, budget: true },
  };
}

/** Which kind a pasted URL looks like (so choosing Slack and pasting a Discord URL can be flagged kindly). */
export function guessAlertKind(raw: string): AlertKind | null {
  try {
    const host = new URL(raw.trim()).hostname.toLowerCase();
    if (host === "hooks.slack.com") return "slack";
    if (DISCORD_HOSTS.includes(host)) return "discord";
  } catch {
    /* not a URL yet */
  }
  return null;
}
