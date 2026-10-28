/**
 * Dev-only bootstrap (imported behind `import.meta.env.DEV`, so it is
 * tree-shaken out of production builds).
 *
 * Deep links for development and screenshots (all on the dev server):
 *   ?mock=1                         use the in-memory mock (default when no server answers)
 *   ?mock=0                         never use the mock
 *   #/  #/agent/<id>  #/inbox  #/new screens (agents: a1…a10; a3 has sub-agents + a queue, a5 a turn summary, a6 is rate-limited)
 *   &pair=1 | &pair=revoked         pairing screen (fresh / "this device was unpaired")
 *   &scope=viewer                   read-only share link (agent a3)
 *   &empty=1                        no agents
 *   &hang=1                         state/items never load (skeletons)
 *   &fail=state,items,permission,prompt,cancel,resume,stop,config,account,create,stream,session-401,session-429,session-down
 *   &toast=permission|done|error    fire an attention event after connecting
 *   &stream=0                       stop the streaming simulation (stable screenshots)
 *   &offline=1                      pretend the device is offline
 *   &sheet=options|details|account|settings open a sheet (inbox / agent / agent / fleet)
 *   &expand=1                       expand every tool call / thought
 *   &latency=<ms>                   mock network latency (default 160)
 *   &stress=1[&items=3000&rate=60]  agent s1 (#/agent/s1): huge timeline + fast text deltas
 */
import type { DevOverrides } from "@/lib/controller";

export async function resolveDevBackend(): Promise<DevOverrides | null> {
  const params = new URLSearchParams(location.search);
  const mock = params.get("mock");
  if (mock === "0") return null;
  if (mock !== "1" && (await realServerAvailable())) return null;
  if (mock !== "1") console.info("[armada] No server at /api/session, using the in-memory mock (add ?mock=0 to disable).");

  if (params.get("offline") === "1") {
    Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: () => false });
  }

  const { MockBackend, scenarioFromParams } = await import("./server");
  const scenario = scenarioFromParams(params);
  const backend = new MockBackend(scenario);
  return scenario.pair ? { backend, forceUnpaired: scenario.pair } : { backend };
}

async function realServerAvailable(): Promise<boolean> {
  try {
    const res = await fetch("/api/session", { cache: "no-store" });
    return (res.headers.get("content-type") ?? "").includes("application/json");
  } catch {
    return false;
  }
}
