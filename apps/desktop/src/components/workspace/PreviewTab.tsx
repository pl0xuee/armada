import {
  ArrowLeft,
  Camera,
  CircleAlert,
  Crosshair,
  Ellipsis,
  ExternalLink,
  Globe,
  Maximize2,
  Minimize2,
  MessageSquarePlus,
  Monitor,
  MonitorSmartphone,
  RefreshCw,
  Server,
  Smartphone,
  SquareTerminal,
  Tablet,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { insertAttachments, insertIntoDraft } from "@/components/agent/drafts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  DropdownMenu,
  DropdownMenuCheckItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { Spinner } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { openExternal } from "@/lib/external";
import { effectiveLoopbackUrl, parseLoopbackUrl, urlPort } from "@/lib/ports";
import { formatErrorsSummary, formatPicked, shotToAttachment, type ShotResult } from "@/lib/previewBridge";
import type { Agent } from "@/lib/types";
import { modKey } from "@/lib/utils";
import { closePreview, markPreviewSeen, patchPreview, previewOf, usePreview } from "@/store/preview";
import { setPreviewToolPref, usePreviewTools } from "@/store/previewTools";
import { useUi } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import { PreviewConsole } from "./PreviewConsole";
import { usePreviewPage } from "./usePreviewPage";

interface Preset {
  value: string;
  label: string;
  width: number | null;
  icon: LucideIcon;
  /** Bezel thickness around the page (device frame), px. */
  bezel: number;
  radius: number;
}

const PRESETS: Preset[] = [
  { value: "auto", label: "Responsive", width: null, icon: MonitorSmartphone, bezel: 0, radius: 0 },
  { value: "390", label: "Mobile · 390", width: 390, icon: Smartphone, bezel: 8, radius: 30 },
  { value: "768", label: "Tablet · 768", width: 768, icon: Tablet, bezel: 8, radius: 20 },
  { value: "1280", label: "Desktop · 1280", width: 1280, icon: Monitor, bezel: 1, radius: 10 },
];

const PAD = 20;
const CAPTION = 22;

/** Live width and height of an element. */
function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

type Probe = "probing" | "up" | "down";

/**
 * The Preview pane: URL bar and controls on top, the page below. `full` means it covers the whole
 * agent view (maximized, or the window is too narrow for chat and preview side by side); `forced` is
 * the latter, where there is nothing to maximize.
 */
export function PreviewTab({ agent, full = false, forced = false }: { agent: Agent; full?: boolean; forced?: boolean }) {
  const st = usePreview((s) => previewOf(s, agent.id));
  const [text, setText] = useState(st.url);
  const [reload, setReload] = useState(0);
  const [probe, setProbe] = useState<Probe>("probing");
  const [loaded, setLoaded] = useState(false);
  const [bodyRef, body] = useElementSize<HTMLDivElement>();
  const newest = st.live[st.live.length - 1];
  const prefs = usePreviewTools();
  const [shooting, setShooting] = useState(false);

  // Showing the pane acknowledges any detected server (clears the header's "new" dot), and picks the
  // most recently mentioned live one when nothing is selected yet.
  useEffect(() => {
    markPreviewSeen(agent.id);
    if (newest && !previewOf(usePreview.getState(), agent.id).url) patchPreview(agent.id, { url: newest, auto: true });
  }, [agent.id, newest]);

  // The field follows the store (links, detection, the servers menu).
  useEffect(() => setText(st.url), [st.url]);

  const url = parseLoopbackUrl(st.url);
  const port = url ? urlPort(url) : null;
  const urlRef = useRef(url);
  urlRef.current = url;

  // Is anything listening? Checked before the iframe loads so a dead server gets a real message
  // instead of the browser's error page; re-checked quietly while it is down.
  useEffect(() => {
    if (port === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoaded(false);
    setProbe("probing");
    const check = (first: boolean) => {
      api
        .probeLoopback([port])
        .then((fams) => {
          if (cancelled) return;
          const cur = urlRef.current;
          const eff = cur ? effectiveLoopbackUrl(cur, fams.find((f) => f.port === port) ?? { v4: false, v6: false }) : null;
          if (eff) {
            // Load the family that answers (e.g. a server bound only to ::1): show it in the field.
            if (eff !== cur) patchPreview(agent.id, { url: eff });
            setProbe("up");
          } else {
            setProbe("down");
            timer = setTimeout(() => check(false), 3000);
          }
        })
        .catch(() => {
          // Can't probe: try loading anyway.
          if (!cancelled && first) setProbe("up");
        });
    };
    check(true);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [port, reload, agent.id, url]);

  // Never leave the loading veil up forever (a page that loads slowly is still visible behind it).
  useEffect(() => {
    if (probe !== "up" || loaded) return;
    const t = setTimeout(() => setLoaded(true), 12_000);
    return () => clearTimeout(t);
  }, [probe, loaded, reload, url]);

  const go = (raw: string) => {
    const u = parseLoopbackUrl(raw);
    if (!u) {
      toast.error("Only localhost, 127.0.0.1 and [::1] (http or https) can be previewed");
      return;
    }
    setText(u);
    patchPreview(agent.id, { url: u, auto: false });
    setReload((n) => n + 1);
  };

  const exit = useCallback(() => {
    if (forced) closePreview(agent.id);
    else patchPreview(agent.id, { maximized: false });
  }, [agent.id, forced]);

  // Page tools: the preview goes through the local proxy, whose injected agent reports back by postMessage.
  const afterInsert = () => {
    useUi.getState().focusComposer();
    if (full) exit();
  };
  const page = usePreviewPage({
    agentId: agent.id,
    url,
    enabled: prefs.tools,
    frameKey: `${url}#${reload}`,
    handlers: {
      picked: (info) => {
        insertIntoDraft(agent.id, formatPicked(info, { pageUrl: urlRef.current ?? "", width: st.width }));
        if (!usePreviewTools.getState().pickShot) afterInsert();
      },
      pickShot: (_selector, result) => {
        attachShot(result, "preview-element");
        afterInsert();
      },
    },
  });
  const attachShot = (result: ShotResult, name: string) => {
    if (!result.ok) {
      toast.error("Couldn't capture the page", { description: result.error });
      return false;
    }
    const a = shotToAttachment(result, name);
    if (!a.ok) {
      toast.error("Couldn't attach the screenshot", { description: a.error });
      return false;
    }
    if (!insertAttachments(agent.id, [a.attachment])) {
      toast.error("Open the message box to attach the screenshot");
      return false;
    }
    return true;
  };
  const toolsReady = page.tools === "ready";
  const toolsWhy =
    page.tools === "off"
      ? prefs.tools
        ? "Page tools need an http:// localhost address"
        : "Page tools are off (More menu)"
      : page.tools === "unavailable"
        ? "Unavailable for this page (its security policy or content type blocks the helper script)"
        : "Waiting for the page to load";
  const screenshot = async () => {
    if (shooting || !toolsReady) return;
    setShooting(true);
    try {
      const r = await page.screenshot();
      if (attachShot(r, "preview")) afterInsert();
    } finally {
      setShooting(false);
    }
  };
  const sendErrors = () => {
    const dev = url ? new URL(url) : null;
    insertIntoDraft(
      agent.id,
      formatErrorsSummary(page.entries, {
        pageUrl: url ?? "",
        proxyOrigin: page.frameSrc && url ? new URL(page.frameSrc).origin : "",
        devOrigin: dev?.origin ?? "",
      }),
    );
    afterInsert();
  };
  const toggleInspect = () => {
    if (!toolsReady) return;
    page.inspect(!page.inspecting, prefs.pickShot);
  };
  // Esc stops picking (before it can leave the full-view preview).
  const inspecting = page.inspecting;
  const stopInspect = page.inspect;
  useEffect(() => {
    if (!inspecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      stopInspect(false, false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [inspecting, stopInspect]);

  // Esc leaves the full-view preview (when focus is in the app, not inside the page itself).
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"]'))
        return;
      e.preventDefault();
      exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full, exit]);

  const preset = PRESETS.find((p) => p.width === st.width) ?? PRESETS[0];
  const options = st.live.map((u) => u.replace(/^https?:\/\//, "").replace(/\/$/, ""));
  const send = () => {
    const w = st.width ? `device width ${st.width}px` : "responsive width";
    insertIntoDraft(agent.id, `Preview of ${url ?? st.url} (${w}) — please check `);
    useUi.getState().focusComposer();
    if (full) exit();
  };

  // Device frame geometry: scale the page down when the pane is narrower than the preset.
  const innerW = preset.width ?? 0;
  const availW = Math.max(120, body.w - PAD * 2 - preset.bezel * 2);
  const scale = innerW ? Math.min(1, availW / innerW) : 1;
  const availH = Math.max(120, body.h - PAD * 2 - CAPTION - preset.bezel * 2);

  const frame = (
    // With page tools on, the iframe loads the local preview proxy (127.0.0.1, see preview_proxy.rs)
    // instead of the dev server directly; the address bar still shows the real URL.
    // Security: the page is a different origin from the app (the CSP's frame-src only allows
    // loopback hosts), so same-origin policy keeps it away from the app's DOM, and Tauri only
    // injects IPC for the app's own origin: capabilities/default.json has no `remote` entry,
    // so no localhost page can invoke commands. allow-same-origin here applies to the *page's*
    // origin so dev servers can use storage/cookies; there is no top-navigation permission.
    <iframe
      key={`${url}#${reload}`}
      ref={page.iframeRef}
      src={page.frameSrc ?? undefined}
      title="App preview"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      referrerPolicy="no-referrer"
      onLoad={() => {
        setLoaded(true);
        page.onFrameLoad();
      }}
      className="block border-0 bg-white"
      style={
        preset.width
          ? {
              width: innerW,
              height: availH / scale,
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
            }
          : { width: "100%", height: "100%" }
      }
    />
  );

  return (
    <div className="@container flex h-full min-h-0 min-w-0 flex-1 flex-col bg-base">
      <div className="flex h-[41px] shrink-0 items-center gap-0.5 border-b border-line px-2">
        {full && (
          <Tooltip content={forced ? "Close preview" : "Back to chat"} shortcut={["Esc"]}>
            <Button size="icon-sm" variant="ghost" aria-label="Back to chat" onClick={exit} className="mr-0.5">
              <ArrowLeft />
            </Button>
          </Tooltip>
        )}
        <form
          className="mr-1 flex min-w-0 flex-1 items-center"
          onSubmit={(e) => {
            e.preventDefault();
            go(text);
          }}
        >
          <div className="relative min-w-0 flex-1">
            <Globe className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-steel" />
            <Input
              className="h-7 min-w-0 pl-7 pr-2 font-mono text-[12px]"
              aria-label="Preview URL"
              placeholder="localhost:3000"
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        </form>
        {options.length > 1 && (
          <DropdownMenu>
            <Tooltip content="Detected servers">
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Detected servers">
                  <Server />
                </Button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end">
              {st.live
                .map((u, i) => ({ u, label: options[i] }))
                .reverse()
                .map(({ u, label }, i) => (
                  <DropdownMenuCheckItem
                    key={u}
                    checked={!!url && urlPort(url) === urlPort(u)}
                    onSelect={() => go(u)}
                    description={i === 0 ? "Most recently mentioned" : null}
                  >
                    <span className="font-mono text-[12px]">{label}</span>
                  </DropdownMenuCheckItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <DropdownMenu>
          <Tooltip content={`Device: ${preset.label}`}>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Device width">
                <preset.icon />
              </Button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="end">
            {PRESETS.map((p) => (
              <DropdownMenuCheckItem
                key={p.value}
                checked={p.value === preset.value}
                onSelect={() => patchPreview(agent.id, { width: p.width })}
              >
                <span className="flex items-center gap-2">
                  <p.icon className="!h-3.5 !w-3.5 text-muted" />
                  {p.label}
                </span>
              </DropdownMenuCheckItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip content="Reload">
          <Button size="icon-sm" variant="ghost" aria-label="Reload preview" onClick={() => setReload((n) => n + 1)}>
            <RefreshCw />
          </Button>
        </Tooltip>
        <span className="mx-0.5 hidden h-4 w-px bg-line @[420px]:block" aria-hidden />
        <Tooltip content={toolsReady ? "Send a screenshot to the agent" : `Screenshot: ${toolsWhy}`}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Send screenshot to agent"
            className="hidden @[420px]:inline-flex"
            disabled={!url || !toolsReady || shooting}
            onClick={() => void screenshot()}
          >
            {shooting ? <Spinner className="h-3.5 w-3.5" /> : <Camera />}
          </Button>
        </Tooltip>
        <Tooltip
          content={toolsReady ? (page.inspecting ? "Stop picking" : "Pick an element to send to the agent") : `Inspect: ${toolsWhy}`}
          shortcut={page.inspecting ? ["Esc"] : undefined}
        >
          <Button
            size="icon-sm"
            variant={page.inspecting ? "secondary" : "ghost"}
            aria-label="Inspect element"
            aria-pressed={page.inspecting}
            className={page.inspecting ? "hidden text-accent @[420px]:inline-flex" : "hidden @[420px]:inline-flex"}
            disabled={!url || !toolsReady}
            onClick={toggleInspect}
          >
            <Crosshair />
          </Button>
        </Tooltip>
        <PreviewConsole
          entries={page.entries}
          tools={page.tools}
          onSend={sendErrors}
          onClear={page.clear}
          className="hidden @[420px]:inline-flex"
        />
        <Tooltip content="Add the preview URL to your message">
          <Button size="xs" variant="secondary" aria-label="Send to agent" disabled={!url} onClick={send} className="ml-0.5">
            <MessageSquarePlus className="!h-3 !w-3" />
            <span className="hidden @[620px]:inline">Send to agent</span>
          </Button>
        </Tooltip>
        <DropdownMenu>
          <Tooltip content="More">
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="More preview actions">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!url} onSelect={() => url && void openExternal(url)}>
              <ExternalLink /> Open in browser
            </DropdownMenuItem>
            {body.w < 420 && (
              <>
                <DropdownMenuItem disabled={!url || !toolsReady || shooting} onSelect={() => void screenshot()}>
                  <Camera /> Send screenshot to agent
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!url || !toolsReady} onSelect={toggleInspect}>
                  <Crosshair /> {page.inspecting ? "Stop picking" : "Inspect element"}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={page.entries.length === 0} onSelect={sendErrors}>
                  <CircleAlert /> Send console problems{page.entries.length ? ` (${page.entries.length})` : ""}
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuCheckItem
              checked={prefs.pickShot}
              onSelect={() => setPreviewToolPref({ pickShot: !prefs.pickShot })}
              description="Also attach a cropped image of the picked element"
            >
              Include element screenshot
            </DropdownMenuCheckItem>
            <DropdownMenuCheckItem
              checked={prefs.tools}
              onSelect={() => setPreviewToolPref({ tools: !prefs.tools })}
              description="Routes the page through a local proxy. Turn off if the app misbehaves behind it."
            >
              Page tools
            </DropdownMenuCheckItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        {!forced && (
          <Tooltip content={st.maximized ? "Restore" : "Maximize"}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={st.maximized ? "Restore preview" : "Maximize preview"}
              aria-pressed={st.maximized}
              onClick={() => patchPreview(agent.id, { maximized: !st.maximized })}
            >
              {st.maximized ? <Minimize2 /> : <Maximize2 />}
            </Button>
          </Tooltip>
        )}
        <Tooltip content="Close preview" shortcut={[modKey, "⇧", "P"]}>
          <Button size="icon-sm" variant="ghost" aria-label="Close preview" onClick={() => closePreview(agent.id)}>
            <X />
          </Button>
        </Tooltip>
      </div>

      <div
        ref={bodyRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        style={
          preset.width
            ? {
                background:
                  "radial-gradient(color-mix(in srgb, var(--text-3, #888) 22%, transparent) 1px, transparent 1px) 0 0 / 14px 14px, color-mix(in srgb, var(--bg-2) 70%, var(--bg-0, #000))",
              }
            : undefined
        }
      >
        {!url ? (
          <Empty
            icon={<Globe className="h-5 w-5" />}
            title="Nothing to preview yet"
            body={
              st.live.length
                ? "Pick a detected server or enter a localhost URL."
                : "Start a dev server and it shows up here, or enter a localhost URL above."
            }
          >
            <Button
              size="xs"
              variant="secondary"
              onClick={() => {
                useWorkspace.getState().setTab(agent.id, "terminal");
                useUi.getState().setWorkspaceOpen(true);
                if (full) exit();
              }}
            >
              <SquareTerminal className="!h-3 !w-3" /> Open terminal
            </Button>
          </Empty>
        ) : probe === "down" ? (
          <Empty
            icon={<TriangleAlert className="h-5 w-5 text-warn" />}
            title={`Nothing is listening on ${new URL(url).host}`}
            body="Start the dev server, then retry. This pane keeps checking and loads the page as soon as it is up."
          >
            <Button
              size="xs"
              variant="secondary"
              onClick={() => {
                setProbe("probing");
                setReload((n) => n + 1);
              }}
            >
              <RefreshCw className="!h-3 !w-3" /> Retry
            </Button>
          </Empty>
        ) : probe === "up" && page.frameReady ? (
          preset.width ? (
            <div className="flex h-full flex-col items-center justify-center" style={{ padding: PAD }}>
              <div
                className="overflow-hidden bg-[#14161a] shadow-[0_18px_50px_-12px_rgba(0,0,0,0.55)] ring-1 ring-white/10"
                style={{
                  width: innerW * scale + preset.bezel * 2,
                  height: availH + preset.bezel * 2,
                  padding: preset.bezel,
                  borderRadius: preset.radius,
                }}
              >
                <div
                  className="relative h-full w-full overflow-hidden bg-white"
                  style={{ borderRadius: Math.max(0, preset.radius - preset.bezel) }}
                >
                  {frame}
                </div>
              </div>
              <div className="mt-1.5 flex h-[14px] items-center text-[11px] leading-none text-steel tabular">
                {innerW}px{scale < 1 && <> · {Math.round(scale * 100)}%</>}
              </div>
            </div>
          ) : (
            frame
          )
        ) : null}

        {url && probe !== "down" && !(probe === "up" && page.frameReady && loaded) && (
          <div
            className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-base/80 backdrop-blur-[2px]"
            role="status"
            aria-label="Loading preview"
          >
            <Spinner className="h-5 w-5" />
            <p className="font-mono text-[11.5px] text-muted">{new URL(url).host}</p>
          </div>
        )}

        {full && (
          <button
            type="button"
            onClick={exit}
            className="glass edge-strong absolute bottom-4 left-4 z-20 inline-flex h-8 items-center gap-2 rounded-full border border-line-strong pl-2.5 pr-2 text-[12px] font-medium text-fg shadow-lg shadow-black/30 outline-none transition-[background-color,transform] hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent/60 active:scale-[0.98]"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {forced ? "Close preview" : "Back to chat"}
            <Kbd>Esc</Kbd>
          </button>
        )}
      </div>
    </div>
  );
}

function Empty({
  icon,
  title,
  body,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-xl border border-line-strong bg-gradient-to-b from-raised to-card text-steel edge">
        {icon}
      </div>
      <p className="text-[13px] font-medium text-fg">{title}</p>
      <p className="max-w-[300px] text-[12.5px] leading-relaxed text-steel">{body}</p>
      {children && <div className="mt-1.5 flex items-center gap-2">{children}</div>}
    </div>
  );
}
