import { ClipboardPaste, Globe, ListChecks, Pencil, Plug, Plus, SquareTerminal, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Badge, Spinner } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { mcpPickup, pickupSummary, scopeServers } from "@/lib/toolkit";
import type { McpServer, McpTransport } from "@/lib/types";
import { basename, cn, errorMessage, uuid } from "@/lib/utils";
import { useApp } from "@/store/app";
import { cleanKeyValues, KeyValueEditor, validateKeyValues, type KeyValueRow } from "./KeyValueEditor";
import { FieldError } from "./TemplatesSection";
import { McpPasteDialog } from "./McpPasteDialog";
import { McpTestButton, McpTestOutcome } from "./McpTestResult";
import { useMcpTestResult, useMcpTests } from "./mcpTest";

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

export function McpSection({ servers, project }: { servers: McpServer[]; project?: string | null }) {
  // `scope` is where a new server goes to: "" = every project, else that project's folder.
  const [editing, setEditing] = useState<{ server: McpServer | null; scope: string } | null>(null);
  const [deleting, setDeleting] = useState<McpServer | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [pasting, setPasting] = useState<string | null>(null);
  const tests = useMcpTests((s) => s.results);
  const scoped = scopeServers(servers, project ?? null);
  const visible = [...scoped.project, ...scoped.global];
  const enabled = visible.filter((s) => s.enabled).length;
  const testing = visible.some((s) => tests[s.id]?.state === "running");

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

  /** Tests every enabled server, a few at a time (each one starts a process or opens a connection). */
  const testAll = async () => {
    const queue = visible.filter((s) => s.enabled);
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) await useMcpTests.getState().run(s.id, s);
    };
    await Promise.all([worker(), worker(), worker()]);
  };

  const projectName = project ? basename(project) || project : "";
  const group = (scope: string, list: McpServer[], title: string, hint: string) => (
    <section aria-label={title} className="mb-6">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-x-3 gap-y-2 px-0.5">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold leading-[18px] tracking-tight text-fg">{title}</h3>
          <p className="text-[12px] leading-[18px] text-muted">{hint}</p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setPasting(scope)}>
            <ClipboardPaste /> Paste config
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setEditing({ server: null, scope })}>
            <Plus /> Add server
          </Button>
        </div>
      </div>
      {list.length === 0 ? (
        <div className="flex items-center gap-3 rounded-xl border border-dashed border-line-strong bg-card/40 px-4 py-4">
          <Plug className="h-4 w-4 shrink-0 text-steel" />
          <p className="text-[12.5px] leading-[18px] text-muted">
            {scope
              ? `No servers only for ${projectName}. Add one that this project's agents should get on top of the shared ones.`
              : "No shared servers. Connect databases, issue trackers and internal tools once and every agent can use them."}
          </p>
        </div>
      ) : (
        <ul
          aria-label={title}
          className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card edge"
        >
          {list.map((s) => (
            <ServerRow
              key={s.id}
              server={s}
              shadowed={scoped.shadowed.has(s.id)}
              busy={toggling === s.id}
              onToggle={(on) => void toggle(s, on)}
              onEdit={() => setEditing({ server: s, scope: s.projectPath ?? "" })}
              onDelete={() => setDeleting(s)}
            />
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 basis-[260px] text-[13px] leading-[20px] text-muted">
          Every agent, on every provider, can use these. Changes apply to agents started or resumed afterwards.
          {visible.length > 0 && (
            <>
              {" "}
              <span className="tabular text-fg">{enabled}</span> of <span className="tabular">{visible.length}</span>{" "}
              on.
            </>
          )}
        </p>
        <Button size="sm" variant="ghost" disabled={enabled === 0 || testing} onClick={() => void testAll()}>
          {testing ? <Spinner className="h-3.5 w-3.5" /> : <ListChecks />} {testing ? "Testing…" : "Test all"}
        </Button>
      </div>

      {project &&
        group(project, scoped.project, `Only ${projectName}`, "Only agents running in this project get these.")}
      {group("", scoped.global, "All projects", "Every agent gets these, wherever it runs.")}

      {scoped.elsewhere > 0 && (
        <p className="-mt-2 mb-4 px-0.5 text-[12px] leading-[18px] text-steel">
          {scoped.elsewhere} more {scoped.elsewhere === 1 ? "server belongs" : "servers belong"} to other projects.
        </p>
      )}

      <McpPasteDialog
        open={pasting !== null}
        onOpenChange={(o) => !o && setPasting(null)}
        existing={servers.filter((s) => (s.projectPath ?? "") === (pasting ?? ""))}
        scope={pasting ?? ""}
      />

      <McpDialog
        key={editing === null ? "closed" : (editing.server?.id ?? `new:${editing.scope}`)}
        editing={editing}
        servers={servers}
        projectName={projectName}
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
  shadowed,
  busy,
  onToggle,
  onEdit,
  onDelete,
}: {
  server: McpServer;
  /** A same-named project server replaces this one for the project on screen. */
  shadowed: boolean;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const stdio = server.transport === "stdio";
  const Icon = stdio ? SquareTerminal : Globe;
  const secrets = stdio ? server.env.length : server.headers.length;
  const shownArgs = server.args.slice(0, 4);
  const tested = useMcpTestResult(server.id, server);
  const pickup = mcpPickup(server, shadowed);
  return (
    <li className="group px-4 py-3 transition-colors hover:bg-raised/40">
      <div className="flex items-center gap-3">
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
            {!server.enabled ? (
              <Badge>Off</Badge>
            ) : tested?.state === "ok" ? (
              <Badge tone="ok">Connected</Badge>
            ) : tested?.state === "error" ? (
              <Badge tone="err">Failed</Badge>
            ) : null}
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted">
            {stdio ? (
              <>
                <span className="shrink-0 font-mono text-fg/85">{server.command}</span>
                {shownArgs.map((a, i) => (
                  <span
                    key={i}
                    className="min-w-0 max-w-[180px] truncate rounded border border-line bg-base/50 px-1 font-mono text-[11px] text-muted"
                  >
                    {a}
                  </span>
                ))}
                {server.args.length > shownArgs.length && (
                  <span className="shrink-0 text-[11px] text-steel">+{server.args.length - shownArgs.length}</span>
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
          <span
            className="mt-0.5 block truncate text-[11.5px] leading-[16px] text-steel"
            title={pickup.note ?? undefined}
          >
            {pickup.agents.length > 0 ? `Used by ${pickupSummary(pickup.agents)}` : pickup.note}
            {pickup.agents.length > 0 && pickup.note && " · " + pickup.note}
          </span>
        </button>
        <McpTestButton testKey={server.id} server={server} className="shrink-0 max-sm:px-2" />
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
            <Switch checked={server.enabled} onCheckedChange={onToggle} aria-label={`${server.name} enabled`} />
          )}
        </span>
      </div>
      <McpTestOutcome testKey={server.id} server={server} className="ml-11 mt-2" />
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
  projectName,
  onClose,
}: {
  editing: { server: McpServer | null; scope: string } | null;
  servers: McpServer[];
  projectName: string;
  onClose: () => void;
}) {
  const initial = editing?.server ?? null;
  const scope = editing?.scope ?? "";
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
      : servers.some(
            (s) =>
              s.id !== initial?.id &&
              (s.projectPath ?? "") === scope &&
              s.name.trim().toLowerCase() === name.trim().toLowerCase(),
          )
        ? "Another server here already uses this name."
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

  const [draftId] = useState(() => initial?.id ?? uuid());
  const draft: McpServer = {
    id: draftId,
    name: name.trim(),
    enabled: initial?.enabled ?? true,
    transport,
    command: stdio ? command.trim() : "",
    args: stdio ? argList : [],
    env: stdio ? cleanKeyValues(env) : [],
    url: stdio ? "" : url.trim(),
    headers: stdio ? [] : cleanKeyValues(headers),
    projectPath: scope,
  };
  const testable = stdio ? !errors.command && !kvInvalid : !errors.url && !kvInvalid;

  const submit = async () => {
    setAttempted(true);
    if (!valid) {
      // The button stays enabled so a click explains itself: reveal errors and focus the first one.
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[role="dialog"] [aria-invalid="true"]')?.focus(),
      );
      return;
    }
    if (saving) return;
    setSaving(true);
    const server = draft;
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
        description={
          scope ? `Only agents running in ${projectName} get it.` : "Shared with every agent on every provider."
        }
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
                  ? "Kvistcode starts the server as a subprocess next to each agent."
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
            <div className="rounded-xl border border-line bg-card/60 p-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">Connection test</p>
                  <p className="text-[12px] text-steel">Starts the server, lists its tools, then stops it.</p>
                </div>
                <McpTestButton testKey={draftId} server={draft} label="Test connection" disabled={!testable} />
              </div>
              <McpTestOutcome testKey={draftId} server={draft} className="mt-2.5" />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving && <Spinner className="h-3.5 w-3.5 text-current" />}
              {initial ? "Save changes" : "Add server"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
