import { Globe, Pencil, Plug, Plus, SquareTerminal, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Badge, Spinner } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import type { McpServer, McpTransport } from "@/lib/types";
import { cn, errorMessage, uuid } from "@/lib/utils";
import { useApp } from "@/store/app";
import { cleanKeyValues, KeyValueEditor, validateKeyValues, type KeyValueRow } from "./KeyValueEditor";
import { SectionHeader } from "./SettingRow";
import { FieldError } from "./TemplatesSection";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

async function saveServers(mcpServers: McpServer[], failure: string): Promise<boolean> {
  const settings = useApp.getState().settings;
  if (!settings) return false;
  try {
    await useApp.getState().setSettings({ ...settings, mcpServers });
    return true;
  } catch (e) {
    toast.error(failure, { description: errorMessage(e) });
    return false;
  }
}

export function McpSection({ servers }: { servers: McpServer[] }) {
  const [editing, setEditing] = useState<McpServer | "new" | null>(null);
  const [deleting, setDeleting] = useState<McpServer | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const enabled = servers.filter((s) => s.enabled).length;

  const toggle = async (server: McpServer, on: boolean) => {
    setToggling(server.id);
    const ok = await saveServers(
      servers.map((s) => (s.id === server.id ? { ...s, enabled: on } : s)),
      on ? `Couldn't enable ${server.name}` : `Couldn't disable ${server.name}`,
    );
    setToggling(null);
    if (ok)
      toast.success(`${server.name} ${on ? "enabled" : "disabled"}`, {
        description: "Applies to agents started or resumed from now on.",
      });
  };

  const remove = async (server: McpServer) => {
    const ok = await saveServers(
      servers.filter((s) => s.id !== server.id),
      `Couldn't remove ${server.name}`,
    );
    setDeleting(null);
    if (ok) toast(`Removed ${server.name}`);
  };

  return (
    <>
      <SectionHeader
        title="Tools (MCP)"
        description="Servers here are available to every agent, on every provider. Changes apply to agents started (or resumed) afterwards."
        right={
          <Button variant="secondary" onClick={() => setEditing("new")} className="shrink-0">
            <Plus /> Add server
          </Button>
        }
      />

      {servers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong bg-card/40">
          <EmptyState
            icon={<Plug />}
            title="No MCP servers"
            description="Connect databases, issue trackers and internal tools once, and every agent can use them, whichever provider it runs on."
            action={
              <Button variant="primary" onClick={() => setEditing("new")}>
                <Plus /> Add a server
              </Button>
            }
          />
        </div>
      ) : (
        <>
          <div className="mb-2.5 px-0.5 text-[12px] text-muted">
            <span className="tabular text-fg">{enabled}</span> of <span className="tabular">{servers.length}</span>{" "}
            enabled
          </div>
          <ul
            aria-label="MCP servers"
            className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card edge"
          >
            {servers.map((s) => (
              <ServerRow
                key={s.id}
                server={s}
                busy={toggling === s.id}
                onToggle={(on) => void toggle(s, on)}
                onEdit={() => setEditing(s)}
                onDelete={() => setDeleting(s)}
              />
            ))}
          </ul>
        </>
      )}

      <McpDialog
        key={editing === null ? "closed" : editing === "new" ? "new" : editing.id}
        editing={editing}
        servers={servers}
        onClose={() => setEditing(null)}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        danger
        title={`Remove ${deleting?.name ?? "server"}?`}
        description="Agents started or resumed afterwards won't have access to its tools. Its environment variables and headers are deleted too."
        confirmLabel="Remove server"
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      />
    </>
  );
}

function ServerRow({
  server,
  busy,
  onToggle,
  onEdit,
  onDelete,
}: {
  server: McpServer;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const stdio = server.transport === "stdio";
  const Icon = stdio ? SquareTerminal : Globe;
  const secrets = stdio ? server.env.length : server.headers.length;
  const shownArgs = server.args.slice(0, 4);
  return (
    <li className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-raised/40">
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-raised transition-colors",
          server.enabled ? "text-accent" : "text-steel",
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <button
        type="button"
        onClick={onEdit}
        className="min-w-0 flex-1 rounded-md text-left"
        aria-label={`Edit ${server.name}`}
      >
        <span className="flex items-center gap-2">
          <span className={cn("truncate text-[13px] font-medium", server.enabled ? "text-fg" : "text-muted")}>
            {server.name}
          </span>
          <Badge tone={stdio ? "neutral" : "accent"}>{stdio ? "stdio" : "HTTP"}</Badge>
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted">
          {stdio ? (
            <>
              <span className="shrink-0 font-mono text-fg/85">{server.command}</span>
              {shownArgs.map((a, i) => (
                <span
                  key={i}
                  className="min-w-0 max-w-[180px] truncate rounded border border-line bg-base/50 px-1 font-mono text-[10.5px] text-muted"
                >
                  {a}
                </span>
              ))}
              {server.args.length > shownArgs.length && (
                <span className="shrink-0 text-[10.5px] text-steel">+{server.args.length - shownArgs.length}</span>
              )}
            </>
          ) : (
            <span className="truncate font-mono">{server.url}</span>
          )}
          {secrets > 0 && (
            <span className="shrink-0 text-steel">
              · {secrets} {stdio ? (secrets === 1 ? "env var" : "env vars") : secrets === 1 ? "header" : "headers"}
            </span>
          )}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <Tooltip content="Edit">
          <Button size="icon-sm" variant="ghost" aria-label={`Edit ${server.name}`} onClick={onEdit}>
            <Pencil className="!h-3.5 !w-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content="Remove">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${server.name}`}
            onClick={onDelete}
            className="hover:text-err"
          >
            <Trash2 className="!h-3.5 !w-3.5" />
          </Button>
        </Tooltip>
      </div>
      <span className="flex w-[34px] shrink-0 justify-end">
        {busy ? (
          <Spinner className="h-3.5 w-3.5" />
        ) : (
          <Switch
            checked={server.enabled}
            onCheckedChange={onToggle}
            aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
          />
        )}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------- add / edit dialog

function toRows(kvs: { name: string; value: string }[], prefix: string): KeyValueRow[] {
  return kvs.map((kv, i) => ({ ...kv, key: `${prefix}-${i}` }));
}

function validUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

function McpDialog({
  editing,
  servers,
  onClose,
}: {
  editing: McpServer | "new" | null;
  servers: McpServer[];
  onClose: () => void;
}) {
  const initial = editing && editing !== "new" ? editing : null;
  const [name, setName] = useState(initial?.name ?? "");
  const [transport, setTransport] = useState<McpTransport>(initial?.transport ?? "stdio");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [args, setArgs] = useState((initial?.args ?? []).join("\n"));
  const [env, setEnv] = useState<KeyValueRow[]>(() => toRows(initial?.env ?? [], "env"));
  const [url, setUrl] = useState(initial?.url ?? "");
  const [headers, setHeaders] = useState<KeyValueRow[]>(() => toRows(initial?.headers ?? [], "hdr"));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const counter = useRef(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const newKey = () => `new-${++counter.current}`;
  const show = (field: string) => attempted || touched[field];
  const touch = (field: string) => () => setTouched((t) => ({ ...t, [field]: true }));

  const stdio = transport === "stdio";
  const envErrors = useMemo(
    () => validateKeyValues(env, ENV_NAME, "Use letters, digits and underscores, not starting with a digit."),
    [env],
  );
  const headerErrors = useMemo(
    () => validateKeyValues(headers, HEADER_NAME, "Header names can't contain spaces or special characters."),
    [headers],
  );
  const errors = {
    name: !name.trim()
      ? "Give the server a name."
      : servers.some((s) => s.id !== initial?.id && s.name.trim().toLowerCase() === name.trim().toLowerCase())
        ? "Another server already uses this name."
        : null,
    command: stdio && !command.trim() ? "Enter the command that starts the server." : null,
    url: !stdio
      ? !url.trim()
        ? "Enter the server URL."
        : !validUrl(url)
          ? "Use a full http:// or https:// URL."
          : null
      : null,
  };
  const kvInvalid = stdio ? Object.keys(envErrors).length > 0 : Object.keys(headerErrors).length > 0;
  const valid = !errors.name && !errors.command && !errors.url && !kvInvalid;
  const argList = args
    .split("\n")
    .map((a) => a.trim())
    .filter(Boolean);
  const commandHasSpaces = stdio && /\s/.test(command.trim()) && argList.length === 0;

  const submit = async () => {
    setAttempted(true);
    if (!valid || saving) return;
    setSaving(true);
    const server: McpServer = {
      id: initial?.id ?? uuid(),
      name: name.trim(),
      enabled: initial?.enabled ?? true,
      transport,
      command: stdio ? command.trim() : "",
      args: stdio ? argList : [],
      env: stdio ? cleanKeyValues(env) : [],
      url: stdio ? "" : url.trim(),
      headers: stdio ? [] : cleanKeyValues(headers),
    };
    const list = initial ? servers.map((s) => (s.id === initial.id ? server : s)) : [...servers, server];
    const ok = await saveServers(list, initial ? `Couldn't save ${server.name}` : `Couldn't add ${server.name}`);
    setSaving(false);
    if (ok) {
      toast.success(initial ? `${server.name} saved` : `${server.name} added`, {
        description: "Applies to agents started or resumed from now on.",
      });
      onClose();
    }
  };

  const errClass = "border-err/60 focus:border-err/70 focus:ring-err/15";

  return (
    <Dialog open={editing !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={initial ? `Edit ${initial.name}` : "Add MCP server"}
        description="Shared with every agent on every provider."
        className="w-[min(620px,calc(100vw-32px))]"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          nameRef.current?.focus();
        }}
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogBody className="space-y-4">
            <div>
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
                ref={nameRef}
                value={name}
                maxLength={60}
                placeholder="e.g. GitHub, Postgres (dev)"
                aria-invalid={show("name") && !!errors.name}
                onChange={(e) => setName(e.target.value)}
                onBlur={touch("name")}
                className={cn(show("name") && errors.name && errClass)}
              />
              {show("name") && errors.name && <FieldError>{errors.name}</FieldError>}
            </div>

            <div>
              <span className="mb-1.5 block text-xs font-medium text-muted">Transport</span>
              <Segmented
                aria-label="Transport"
                value={transport}
                onChange={setTransport}
                className="w-full"
                options={[
                  {
                    value: "stdio",
                    label: (
                      <>
                        <SquareTerminal className="h-3.5 w-3.5" /> Local command (stdio)
                      </>
                    ),
                  },
                  {
                    value: "http",
                    label: (
                      <>
                        <Globe className="h-3.5 w-3.5" /> Remote (HTTP)
                      </>
                    ),
                  },
                ]}
              />
              <p className="mt-1.5 text-[12px] text-steel">
                {stdio
                  ? "Armada starts the server as a subprocess next to each agent."
                  : "Agents connect to a server that's already running, locally or in the cloud."}
              </p>
            </div>

            {stdio ? (
              <>
                <div>
                  <Label htmlFor="mcp-command">Command</Label>
                  <Input
                    id="mcp-command"
                    value={command}
                    placeholder="npx"
                    aria-invalid={show("command") && !!errors.command}
                    onChange={(e) => setCommand(e.target.value)}
                    onBlur={touch("command")}
                    className={cn("font-mono text-[12.5px]", show("command") && errors.command && errClass)}
                  />
                  {show("command") && errors.command ? (
                    <FieldError>{errors.command}</FieldError>
                  ) : commandHasSpaces ? (
                    <p className="mt-1.5 text-[12px] text-warn">
                      Put each argument on its own line below so paths with spaces stay intact.
                    </p>
                  ) : null}
                </div>
                <div>
                  <Label htmlFor="mcp-args">Arguments</Label>
                  <Textarea
                    id="mcp-args"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    placeholder={"-y\n@modelcontextprotocol/server-postgres\npostgresql://localhost/mydb"}
                    className="min-h-[92px] font-mono text-[12px]"
                    spellCheck={false}
                  />
                  <p className="mt-1.5 text-[12px] text-steel">One argument per line. Blank lines are ignored.</p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium text-muted">Environment variables</span>
                  <KeyValueEditor
                    label="Environment variable"
                    rows={env}
                    onChange={setEnv}
                    errors={envErrors}
                    showErrors
                    namePlaceholder="API_TOKEN"
                    valuePlaceholder="value"
                    addLabel="Add variable"
                    newKey={newKey}
                  />
                </div>
              </>
            ) : (
              <>
                <div>
                  <Label htmlFor="mcp-url">URL</Label>
                  <Input
                    id="mcp-url"
                    value={url}
                    type="url"
                    placeholder="https://mcp.example.com/mcp"
                    aria-invalid={show("url") && !!errors.url}
                    onChange={(e) => setUrl(e.target.value)}
                    onBlur={touch("url")}
                    className={cn("font-mono text-[12.5px]", show("url") && errors.url && errClass)}
                  />
                  {show("url") && errors.url && <FieldError>{errors.url}</FieldError>}
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium text-muted">Headers</span>
                  <KeyValueEditor
                    label="Header"
                    rows={headers}
                    onChange={setHeaders}
                    errors={headerErrors}
                    showErrors
                    namePlaceholder="Authorization"
                    valuePlaceholder="Bearer …"
                    addLabel="Add header"
                    newKey={newKey}
                  />
                </div>
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!valid || saving}>
              {saving && <Spinner className="h-3.5 w-3.5 text-current" />}
              {initial ? "Save changes" : "Add server"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
