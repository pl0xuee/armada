import { ClipboardPaste, Globe, SquareTerminal } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Badge, Spinner } from "@/components/ui/misc";
import type { McpServer } from "@/lib/types";
import { cn, errorMessage, uuid } from "@/lib/utils";
import { useApp } from "@/store/app";
import { parseMcpConfig, PasteError, type PasteResult } from "./mcpPaste";

const EXAMPLE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Projects"]
    },
    "linear": { "type": "http", "url": "https://mcp.linear.app/mcp" }
  }
}`;

interface Row {
  key: string;
  include: boolean;
  name: string;
}

/** Import servers from a pasted JSON snippet. Nothing is read from disk. */
export function McpPasteDialog({
  open,
  onOpenChange,
  existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: McpServer[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Paste MCP config"
        description="Paste a JSON snippet (comments are fine) or a `claude mcp add …` command. Nothing is read from your disk."
        className="w-[min(660px,calc(100vw-32px))]"
        sheet
      >
        {open && <PasteBody existing={existing} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function PasteBody({ existing, onDone }: { existing: McpServer[]; onDone: () => void }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const parsed = useMemo((): { result: PasteResult | null; error: string | null } => {
    if (!text.trim()) return { result: null, error: null };
    try {
      return { result: parseMcpConfig(text), error: null };
    } catch (e) {
      return { result: null, error: e instanceof PasteError ? e.message : errorMessage(e) };
    }
  }, [text]);

  // Per-server choices (include / rename) belong to one parse result; a new parse starts fresh.
  const servers = parsed.result?.servers ?? [];
  const sig = servers.map((s) => s.name).join("\u0000");
  const [choices, setChoices] = useState<{ sig: string; rows: Row[] } | null>(null);
  const rows: Row[] =
    choices && choices.sig === sig
      ? choices.rows
      : servers.map((s, i) => ({ key: `${i}-${s.name}`, include: true, name: s.name }));
  const setRows = (update: (rs: Row[]) => Row[]) => setChoices({ sig, rows: update(rows) });

  const taken = new Set(existing.map((s) => s.name.trim().toLowerCase()));
  const conflictOf = (row: Row, i: number): string | null => {
    const n = row.name.trim().toLowerCase();
    if (!n) return "Needs a name";
    if (taken.has(n)) return "Name already in use";
    if (rows.some((r, j) => j < i && r.include && r.name.trim().toLowerCase() === n)) return "Duplicate name";
    return null;
  };
  const chosen = rows.map((r, i) => ({ r, i, conflict: conflictOf(r, i) })).filter((x) => x.r.include);
  const blocked = chosen.some((x) => x.conflict);
  const canAdd = chosen.length > 0 && !blocked && !saving;

  const add = async () => {
    const settings = useApp.getState().settings;
    if (!settings || !canAdd) return;
    setSaving(true);
    const added: McpServer[] = chosen.map(({ r, i }) => ({
      ...servers[i],
      id: uuid(),
      name: r.name.trim(),
      enabled: true,
    }));
    try {
      await useApp.getState().setSettings({ ...settings, mcpServers: [...settings.mcpServers, ...added] });
      toast.success(`Added ${added.length} MCP server${added.length === 1 ? "" : "s"}`, {
        description: "Applies to agents started or resumed from now on.",
      });
      onDone();
    } catch (e) {
      toast.error("Couldn't add the servers", { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogBody className="space-y-4">
        <div>
          <Label htmlFor="mcp-paste">JSON</Label>
          <Textarea
            id="mcp-paste"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={EXAMPLE}
            spellCheck={false}
            aria-invalid={!!parsed.error}
            aria-describedby="mcp-paste-help"
            className={cn(
              "min-h-[150px] font-mono text-[12px] leading-relaxed",
              parsed.error && "border-err/60 focus:border-err/70 focus:ring-err/15",
            )}
          />
          {parsed.error ? (
            <p id="mcp-paste-help" role="alert" className="mt-1.5 text-[12px] text-err">
              {parsed.error}
            </p>
          ) : (
            <p id="mcp-paste-help" className="mt-1.5 text-[12px] text-steel">
              Accepts <code className="font-mono">{'{ "mcpServers": { … } }'}</code> (comments and trailing commas are
              fine), a map of servers, an array, a single server object, or{" "}
              <code className="font-mono">claude mcp add …</code> lines.
            </p>
          )}
        </div>

        {rows.length > 0 && (
          <div>
            <span className="mb-1.5 block text-xs font-medium text-muted">
              {rows.length} server{rows.length === 1 ? "" : "s"} found
            </span>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
              {rows.map((row, i) => {
                const s = servers[i];
                const conflict = row.include ? conflictOf(row, i) : null;
                const stdio = s.transport === "stdio";
                const Icon = stdio ? SquareTerminal : Globe;
                const secrets = stdio ? s.env.length : s.headers.length;
                const update = (patch: Partial<Row>) =>
                  setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
                return (
                  <li key={row.key} className={cn("flex items-start gap-3 px-3 py-2.5", !row.include && "opacity-55")}>
                    <Checkbox
                      checked={row.include}
                      onCheckedChange={(v) => update({ include: v })}
                      aria-label={`Import ${row.name || "server"}`}
                      className="mt-2"
                    />
                    <Icon className="mt-2 h-4 w-4 shrink-0 text-steel" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          value={row.name}
                          onChange={(e) => update({ name: e.target.value })}
                          aria-label="Server name"
                          placeholder="Name this server"
                          disabled={!row.include}
                          className={cn("h-8 max-w-[240px]", conflict && "border-err/60")}
                        />
                        <Badge tone={stdio ? "neutral" : "accent"}>{stdio ? "stdio" : "HTTP"}</Badge>
                        {conflict && <Badge tone="err">{conflict}</Badge>}
                      </div>
                      <p className="mt-1 truncate font-mono text-[11.5px] text-muted">
                        {stdio ? [s.command, ...s.args].join(" ") : s.url}
                        {secrets > 0 && (
                          <span className="font-sans text-steel">
                            {" "}
                            · {secrets} {stdio ? "env var" : "header"}
                            {secrets === 1 ? "" : "s"}
                          </span>
                        )}
                      </p>
                      {conflict === "Name already in use" && (
                        <p className="mt-1 text-[11.5px] text-steel">Rename it, or untick to skip.</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {parsed.result && parsed.result.warnings.length > 0 && (
          <div role="status" className="rounded-lg border border-warn/30 bg-warn/[0.06] px-3 py-2 text-[12px]">
            <p className="font-medium text-warn">Check before adding</p>
            <ul className="mt-1 space-y-0.5 text-muted">
              {parsed.result.warnings.map((w, i) => (
                <li key={i}>
                  <span className="font-mono text-fg/85">{w.name || "(unnamed)"}</span>: {w.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {parsed.result && parsed.result.skipped.length > 0 && (
          <div className="rounded-lg border border-warn/30 bg-warn/[0.06] px-3 py-2 text-[12px]">
            <p className="font-medium text-warn">Skipped {parsed.result.skipped.length}</p>
            <ul className="mt-1 space-y-0.5 text-muted">
              {parsed.result.skipped.map((s, i) => (
                <li key={i}>
                  <span className="font-mono text-fg/85">{s.name || "(unnamed)"}</span>: {s.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!canAdd} onClick={() => void add()}>
          {saving ? <Spinner className="h-3.5 w-3.5 text-current" /> : <ClipboardPaste />}
          {chosen.length > 1 ? `Add ${chosen.length} servers` : "Add server"}
        </Button>
      </DialogFooter>
    </>
  );
}
