import { ExternalLink, Globe, ListChecks, MessageSquarePlus, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { insertIntoDraft } from "@/components/agent/drafts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { openExternal } from "@/lib/external";
import { parseLoopbackUrl } from "@/lib/ports";
import type { Agent } from "@/lib/types";
import { useUi } from "@/store/ui";
import { markPreviewSeen, patchPreview, previewOf, usePreview } from "@/store/preview";
import { useWorkspace } from "@/store/workspace";

const PRESETS: { value: string; label: string; width: number | null }[] = [
  { value: "auto", label: "Responsive", width: null },
  { value: "390", label: "Mobile 390", width: 390 },
  { value: "768", label: "Tablet 768", width: 768 },
  { value: "1280", label: "Desktop 1280", width: 1280 },
];

export function PreviewTab({ agent }: { agent: Agent }) {
  const st = usePreview((s) => previewOf(s, agent.id));
  const setTab = useWorkspace((s) => s.setTab);
  const [text, setText] = useState(st.url);
  const [reload, setReload] = useState(0);
  const newest = st.live[st.live.length - 1];

  // Opening the tab selects the newest detected server and clears the "new server" dot.
  const opened = useRef(false);
  useEffect(() => {
    markPreviewSeen(agent.id);
    if (newest && !opened.current) {
      opened.current = true;
      patchPreview(agent.id, { url: newest });
      setText(newest);
    }
  }, [agent.id, newest]);

  const url = parseLoopbackUrl(st.url);
  const go = (raw: string) => {
    const u = parseLoopbackUrl(raw);
    if (!u) {
      toast.error("Only localhost, 127.0.0.1 and [::1] (http or https) can be previewed");
      return;
    }
    setText(u);
    patchPreview(agent.id, { url: u });
    setReload((n) => n + 1);
  };

  if (!url && st.live.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <Globe className="h-6 w-6 text-steel" />
        <p className="text-[12.5px] text-steel">Start a dev server (Scripts tab) and it shows up here.</p>
        <div className="flex items-center gap-2">
          <Button size="xs" variant="secondary" onClick={() => setTab(agent.id, "scripts")}>
            <ListChecks className="!h-3 !w-3" /> Open Scripts
          </Button>
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              go(text);
            }}
          >
            <Input
              className="h-6 w-44 text-[12px]"
              placeholder="localhost:3000"
              aria-label="Preview URL"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </form>
        </div>
      </div>
    );
  }

  const width = st.width;
  const options = st.live.map((u) => ({ value: u, label: u.replace(/^https?:\/\//, "") }));
  const send = () => {
    const w = width ? `device width ${width}px` : "responsive width";
    insertIntoDraft(agent.id, `Preview of ${url ?? st.url} (${w}) — please check `);
    useUi.getState().focusComposer();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-1.5">
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            go(text);
          }}
        >
          <Input
            className="h-6 min-w-0 flex-1 font-mono text-[12px]"
            aria-label="Preview URL"
            placeholder="http://localhost:3000"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </form>
        {options.length > 0 && (
          <Select
            className="h-6 w-36 text-[12px]"
            aria-label="Detected servers"
            value={options.some((o) => o.value === st.url) ? st.url : undefined}
            placeholder="Detected"
            options={options}
            onValueChange={go}
          />
        )}
        <Select
          className="h-6 w-32 text-[12px]"
          aria-label="Device width"
          value={PRESETS.find((p) => p.width === width)?.value ?? "auto"}
          options={PRESETS.map((p) => ({ value: p.value, label: p.label }))}
          onValueChange={(v) => patchPreview(agent.id, { width: PRESETS.find((p) => p.value === v)?.width ?? null })}
        />
        <Tooltip content="Reload">
          <Button size="icon-sm" variant="ghost" aria-label="Reload preview" onClick={() => setReload((n) => n + 1)}>
            <RefreshCw />
          </Button>
        </Tooltip>
        <Tooltip content="Open in browser">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Open in browser"
            disabled={!url}
            onClick={() => url && void openExternal(url)}
          >
            <ExternalLink />
          </Button>
        </Tooltip>
        <Tooltip content="Add the preview URL to your message (screenshots aren't supported)">
          <Button size="xs" variant="secondary" disabled={!url} onClick={send}>
            <MessageSquarePlus className="!h-3 !w-3" /> Send to agent
          </Button>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-raised/40">
        {url ? (
          // Security: the page is a different origin from the app (the CSP's frame-src only allows
          // loopback hosts), so same-origin policy keeps it away from the app's DOM, and Tauri only
          // injects IPC for the app's own origin: capabilities/default.json has no `remote` entry,
          // so no localhost page can invoke commands. allow-same-origin here applies to the *page's*
          // origin so dev servers can use storage/cookies; there is no top-navigation permission.
          <iframe
            key={`${url}#${reload}`}
            src={url}
            title="App preview"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            referrerPolicy="no-referrer"
            className="mx-auto block h-full border-0 bg-white"
            style={{ width: width ?? "100%", maxWidth: "100%" }}
          />
        ) : (
          <p className="p-4 text-center text-[12.5px] text-steel">Pick a detected server or enter a localhost URL.</p>
        )}
      </div>
    </div>
  );
}
