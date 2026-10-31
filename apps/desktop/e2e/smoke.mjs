// Real-app smoke test. Launches the built Armada binary through tauri-driver (WebDriver),
// then walks the UI the way a user would and fails on any uncaught JS error, error toast
// or "state not managed"-style backend failure. Unit tests can't catch those: the 0.1.3
// release shipped dictation broken at runtime because a command asked for managed state
// that was never registered.
//
// Env:
//   ARMADA_BIN           path to the app binary (default ../../../target/debug/armada)
//   TAURI_DRIVER_PORT    where tauri-driver listens (default 4444)
//   ARMADA_E2E_URL       if set, skip tauri-driver and drive an already-running WebDriver
//                        endpoint with a plain browser at this URL (local dev only)
//   ARMADA_E2E_HOST/PORT the WebDriver endpoint for ARMADA_E2E_URL mode
//
// Run it under an isolated HOME / XDG_* dirs (run.sh does) so the app starts
// from empty state and never touches real data.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { remote } from "webdriverio";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(process.env.ARMADA_BIN ?? path.join(here, "../../../target/debug/armada"));
const port = Number(process.env.TAURI_DRIVER_PORT ?? 4444);
const pageUrl = process.env.ARMADA_E2E_URL;

const failures = [];
const log = (m) => console.log(`[e2e] ${m}`);
const check = (cond, msg) => {
  if (!cond) {
    failures.push(msg);
    console.error(`[e2e] FAIL: ${msg}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(p, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await fetch(`http://127.0.0.1:${p}/status`);
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`tauri-driver did not start listening on :${p}`);
}

let driver = null;
if (!pageUrl) {
  if (!existsSync(bin)) throw new Error(`app binary not found: ${bin} (set ARMADA_BIN)`);
  driver = spawn("tauri-driver", ["--port", String(port)], { stdio: ["ignore", "inherit", "inherit"] });
  driver.on("error", (e) => {
    console.error(`[e2e] could not start tauri-driver: ${e.message}`);
    process.exit(1);
  });
  await waitForPort(port, 20_000);
}

let browser;
const finish = async (code) => {
  try {
    await browser?.deleteSession();
  } catch {}
  driver?.kill();
  process.exit(code);
};

// Installed right after the session starts (the app is still booting then); catches
// uncaught errors and unhandled promise rejections, i.e. what a failed invoke() becomes
// when nothing handles it. console.error is recorded but only reported, not fatal.
const HOOK = `
  if (!window.__e2e) {
    window.__e2e = { errors: [], consoleErrors: [] };
    const fmt = (v) => (v && v.stack) || (v && v.message) || String(v);
    window.addEventListener("error", (e) => window.__e2e.errors.push("error: " + (e.message || fmt(e.error))));
    window.addEventListener("unhandledrejection", (e) => window.__e2e.errors.push("unhandledrejection: " + fmt(e.reason)));
    const ce = console.error.bind(console);
    console.error = (...a) => { window.__e2e.consoleErrors.push(a.map(fmt).join(" ")); ce(...a); };
  }
`;

const caps = pageUrl
  ? { browserName: "chrome", "goog:chromeOptions": { args: ["--headless=new", "--no-sandbox", "--window-size=1440,900"] } }
  : { "tauri:options": { application: bin }, "wdio:enforceWebDriverClassic": true };

try {
  browser = await remote({
    hostname: process.env.ARMADA_E2E_HOST ?? "127.0.0.1",
    port: pageUrl ? Number(process.env.ARMADA_E2E_PORT ?? 9515) : port,
    logLevel: "warn",
    connectionRetryCount: 1,
    capabilities: caps,
  });
  if (pageUrl) await browser.url(pageUrl);
  await browser.execute(HOOK);

  const text = () => browser.execute(() => document.body.innerText);

  /** Fails the run on an error toast, a backend "not managed" message or a boot error. */
  const assertHealthy = async (where) => {
    const toasts = await browser.execute(() =>
      [...document.querySelectorAll("[data-sonner-toast]")]
        .filter((t) => t.getAttribute("data-type") === "error")
        .map((t) => t.textContent ?? ""),
    );
    check(toasts.length === 0, `${where}: error toast(s): ${toasts.join(" | ")}`);
    const body = await text();
    check(!/state not managed|not managed/i.test(body), `${where}: "state not managed" visible in the UI`);
    const errs = await browser.execute(() => window.__e2e?.errors ?? []);
    check(errs.length === 0, `${where}: uncaught JS error(s): ${errs.join(" | ")}`);
  };

  const waitText = (re, what, timeout = 15_000) =>
    browser.waitUntil(async () => re.test(await text()), { timeout, timeoutMsg: `timed out waiting for ${what}` });

  // ---- boot -----------------------------------------------------------------------
  log("waiting for the main window to boot");
  await browser.$('nav[aria-label="Setup steps"], nav[aria-label="Primary"]').waitForExist({
    timeout: 60_000,
    timeoutMsg: "app never reached onboarding or the main shell (boot error?)",
  });
  check(!/couldn.t start|boot error/i.test(await text()), "boot screen shows an error");
  await assertHealthy("boot");

  // ---- onboarding (fresh data dir => first run) -----------------------------------
  const onboarding = await browser.$('nav[aria-label="Setup steps"]');
  if (await onboarding.isExisting()) {
    log("first run: skipping onboarding through the UI");
    await browser.$("button=Skip setup").click();
    await browser.$('nav[aria-label="Primary"]').waitForExist({ timeout: 15_000, timeoutMsg: "Skip setup did not reach the main shell" });
  }
  await assertHealthy("after onboarding");

  // ---- main views -----------------------------------------------------------------
  // [rail aria-label prefix, expected <h1> or null]
  const views = [
    ["Mission Control", "Mission Control"],
    ["Inbox", "Inbox"],
    ["Schedules", "Schedules"],
    ["Usage", "Usage"],
    ["Accounts", "Accounts"],
    ["Projects", null],
  ];
  const goRail = async (label) => {
    const btn = await browser.$(`nav[aria-label="Primary"] button[aria-label^="${label}"]`);
    await btn.waitForExist({ timeout: 10_000, timeoutMsg: `rail button "${label}" missing` });
    await btn.click();
    await browser.waitUntil(async () => (await btn.getAttribute("aria-current")) === "page", {
      timeout: 5_000,
      timeoutMsg: `"${label}" never became the current view`,
    });
  };
  for (const [label, h1] of views) {
    log(`view: ${label}`);
    await goRail(label);
    if (h1) {
      // DOM text, not WebDriver's rendered text (WebKit trims/ellipsizes truncated headings).
      const headings = () =>
        browser.execute(() => [...document.querySelectorAll("h1")].map((e) => (e.textContent || "").trim()));
      try {
        await browser.waitUntil(async () => (await headings()).includes(h1), { timeout: 15_000 });
      } catch {
        const seen = await headings().catch(() => []);
        const text = await browser
          .execute(() => (document.querySelector("main") || document.body).innerText.slice(0, 400))
          .catch(() => "");
        throw new Error(`"${label}" view did not render its "${h1}" heading; h1s: ${JSON.stringify(seen)}; page: ${JSON.stringify(text)}`);
      }
    }
    await sleep(500); // let the view's own loads (accounts list, usage, ...) settle
    await assertHealthy(label);
  }

  // ---- command palette ------------------------------------------------------------
  log("command palette");
  await browser.$('button[aria-label="Open command palette"]').click();
  const input = await browser.$("[cmdk-input]");
  await input.waitForExist({ timeout: 10_000, timeoutMsg: "command palette did not open" });
  await browser.keys("Escape");
  await assertHealthy("command palette");

  // ---- settings sections (each one loads its own backend data) -----------------------
  await goRail("Settings");
  const sections = ["Appearance", "Sounds", "Notifications", "Behavior", "Templates", "Providers", "Agents", "Voice", "Voice assistant", "Remote & mobile", "About"];
  for (const name of sections) {
    log(`settings: ${name}`);
    const btn = await browser.$(`//nav[@aria-label="Settings sections"]//button[.//span[normalize-space(.)="${name}"]]`);
    await btn.waitForExist({ timeout: 10_000, timeoutMsg: `settings section "${name}" missing` });
    await btn.click();
    await browser.waitUntil(async () => (await btn.getAttribute("aria-current")) === "page", { timeout: 5_000 });

    if (name === "Voice") {
      // The 0.1.3 regression: voice_status needed managed state that was never registered.
      // The model list only renders once voice_status resolves.
      await waitText(/\((English|multilingual)\)/, "dictation model list (voice_status result)");
      check(!/Couldn.t read the dictation models/i.test(await text()), "Voice: dictation status failed to load");
    } else {
      await sleep(400);
    }
    await assertHealthy(`settings/${name}`);
  }

  const consoleErrors = await browser.execute(() => window.__e2e?.consoleErrors ?? []);
  if (consoleErrors.length) log(`console.error output (informational):\n  ${consoleErrors.join("\n  ")}`);
} catch (e) {
  failures.push(`test aborted: ${e?.stack ?? e}`);
  console.error(`[e2e] ${e?.stack ?? e}`);
}

if (failures.length) {
  console.error(`\n[e2e] ${failures.length} failure(s):\n - ${failures.join("\n - ")}`);
  await finish(1);
}
log("all checks passed");
await finish(0);
