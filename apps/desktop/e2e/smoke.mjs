// Real-app smoke test. Launches the built Kvistcode binary through tauri-driver (WebDriver),
// then walks the UI the way a user would and fails on any uncaught JS error, error toast
// or "state not managed"-style backend failure. Unit tests can't catch those: the 0.1.3
// release shipped dictation broken at runtime because a command asked for managed state
// that was never registered.
//
// Env:
//   KVISTCODE_BIN           path to the app binary (default ../../../target/debug/kvistcode)
//   TAURI_DRIVER_PORT    where tauri-driver listens (default 4444)
//   KVISTCODE_E2E_URL       if set, skip tauri-driver and drive an already-running WebDriver
//                        endpoint with a plain browser at this URL (local dev only)
//   KVISTCODE_E2E_HOST/PORT the WebDriver endpoint for KVISTCODE_E2E_URL mode
//
// Run it under an isolated HOME / XDG_* dirs (run.sh does) so the app starts
// from empty state and never touches real data.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { remote } from "webdriverio";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(process.env.KVISTCODE_BIN ?? path.join(here, "../../../target/debug/kvistcode"));
const port = Number(process.env.TAURI_DRIVER_PORT ?? 4444);
const pageUrl = process.env.KVISTCODE_E2E_URL;

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
  if (!existsSync(bin)) throw new Error(`app binary not found: ${bin} (set KVISTCODE_BIN)`);
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
    hostname: process.env.KVISTCODE_E2E_HOST ?? "127.0.0.1",
    port: pageUrl ? Number(process.env.KVISTCODE_E2E_PORT ?? 9515) : port,
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

  // The first-run tour is a modal that would block scripted clicks, so the app deliberately
  // never opens it by itself when navigator.webdriver is set (src/lib/tour.ts). Assert that, so a
  // tour that starts covering this run fails loudly here instead of as "element not clickable".
  // The tour itself is exercised from Settings -> About below.
  await sleep(1500); // longer than the tour's settle delay
  check(!(await text()).includes("Skip tour"), "the first-run tour opened by itself under WebDriver");

  // ---- main views -----------------------------------------------------------------
  // [rail aria-label prefix, expected <h1> or null]
  const views = [
    ["Mission Control", "Mission Control"],
    ["Compare", "Compare"],
    ["Schedules", "Schedules"],
    ["Usage", "Usage"],
    ["Accounts", "Accounts"],
    ["Projects", null], // the agent list's rail label (it was "Agents" before 0.2)
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

  // ---- Back / Forward in the title bar (the walk above ended Accounts -> Projects) ------
  const railCurrent = async (label) =>
    (await browser.$(`nav[aria-label="Primary"] button[aria-label^="${label}"]`)).getAttribute("aria-current");
  for (const [button, label] of [["Back", "Accounts"], ["Forward", "Projects"]]) {
    log(`title bar: ${button}`);
    await (await browser.$(`header button[aria-label="${button}"]`)).click();
    await browser.waitUntil(async () => (await railCurrent(label)) === "page", {
      timeout: 5_000,
      timeoutMsg: `${button} did not return to "${label}"`,
    });
    await assertHealthy(`${button.toLowerCase()} to ${label}`);
  }

  // ---- Mission Control tabs (the queue of agents that need you, and every agent) -----
  await goRail("Mission Control");
  for (const tab of ["Needs you", "All agents"]) {
    log(`mission control tab: ${tab}`);
    const radio = await browser.$(
      `//*[@role="radiogroup" and @aria-label="Mission Control"]//button[@role="radio"][contains(normalize-space(.),"${tab}")]`,
    );
    await radio.waitForExist({ timeout: 10_000, timeoutMsg: `Mission Control tab "${tab}" missing` });
    await radio.click();
    await browser.waitUntil(async () => (await radio.getAttribute("aria-checked")) === "true", {
      timeout: 5_000,
      timeoutMsg: `Mission Control tab "${tab}" never became selected`,
    });
    await sleep(300);
    await assertHealthy(`mission control/${tab}`);
  }

  // ---- command palette ------------------------------------------------------------
  log("command palette");
  await browser.$('button[aria-label="Open command palette"]').click();
  const input = await browser.$("[cmdk-input]");
  await input.waitForExist({ timeout: 10_000, timeoutMsg: "command palette did not open" });
  // "?" switches the palette to searching every conversation (Ctrl/Cmd+Shift+F opens it there).
  await browser.keys("?");
  await browser.waitUntil(async () => (await input.getAttribute("aria-label")) === "Search every conversation", {
    timeout: 5_000,
    timeoutMsg: 'typing "?" in the palette did not switch to conversation search',
  });
  await browser.keys("x");
  await sleep(600); // debounce + the search call itself
  await assertHealthy("conversation search");
  await browser.keys("Escape");
  await assertHealthy("command palette");

  // ---- settings sections (each one loads its own backend data) -----------------------
  await goRail("Settings");
  const sections = [
    "General", "Alerts", "Budgets", "Projects", "Tools & instructions", "Providers", "Voice", "Remote & mobile", "About",
  ];
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
    } else if (name === "Tools & instructions") {
      // CLAUDE.md / AGENTS.md, MCP servers and skills: walk the page's tabs.
      await waitText(/What your agents know and can use/, "the Tools & instructions page");
      for (const tab of ["MCP", "Skills"]) {
        const radio = await browser.$(
          `//*[@role="radiogroup"][@aria-label="Tools and instructions"]//*[@role="radio"][contains(normalize-space(.),"${tab}")]`,
        );
        await radio.waitForExist({ timeout: 10_000, timeoutMsg: `Tools & instructions tab "${tab}" missing` });
        await radio.click();
        await sleep(500);
        await assertHealthy(`settings/Tools & instructions/${tab}`);
      }
    } else {
      await sleep(400);
    }
    await assertHealthy(`settings/${name}`);
  }

  // ---- first-run tour, opened by hand (Settings -> About -> Show the tour) -----------
  // About is the last section above. The tour's code loads lazily, so this also catches a
  // broken chunk.
  log("welcome tour");
  await browser.$("button*=Show the tour").click();
  await waitText(/Start an agent/, "the tour's first step");
  await browser.$("button*=Next").click();
  await waitText(/Many agents, one place/, "the tour's second step");
  await browser.$("button*=Next").click();
  await waitText(/What needs you stays in view/, "the tour's third step");
  await browser.$("button*=Next").click();
  await waitText(/Find anything, spend on your terms/, "the tour's fourth step");
  await browser.$("button*=Next").click();
  await waitText(/One key reaches everything/, "the tour's last step");
  await assertHealthy("tour");
  await browser.$("button*=Got it").click();
  await browser.waitUntil(async () => !/One key reaches everything/.test(await text()), {
    timeout: 5_000,
    timeoutMsg: "the tour did not close",
  });
  await assertHealthy("after the tour");

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
