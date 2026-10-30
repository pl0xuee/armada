import { FileLock2, FolderOpen, Plus, ShieldAlert, ShieldCheck, ShieldQuestion, X } from "lucide-react";
import { useState, type ComponentType } from "react";
import { attempt } from "@/lib/actions";
import { api } from "@/lib/api";
import {
  addRule,
  otherKindsHolding,
  removeRule,
  type PermissionRules,
  type RuleKind,
  type SettingsFile,
  type SettingsScope,
} from "@/lib/projectConfig";
import { cn, errorMessage, prettyPath } from "@/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge, Spinner } from "../ui/misc";
import { Segmented } from "../ui/segmented";
import { InlineError } from "./ProjectNotice";

const KINDS: {
  kind: RuleKind;
  title: string;
  blurb: string;
  example: string;
  icon: ComponentType<{ className?: string }>;
  tone: string;
}[] = [
  {
    kind: "allow",
    title: "Allow",
    blurb: "Run without asking.",
    example: "Bash(npm run test:*)",
    icon: ShieldCheck,
    tone: "text-ok",
  },
  {
    kind: "ask",
    title: "Ask",
    blurb: "Always ask first.",
    example: "Bash(git push:*)",
    icon: ShieldQuestion,
    tone: "text-warn",
  },
  {
    kind: "deny",
    title: "Deny",
    blurb: "Never allowed.",
    example: "Read(./.env)",
    icon: ShieldAlert,
    tone: "text-err",
  },
];

function RuleList({
  spec,
  rules,
  disabled,
  busy,
  onChange,
}: {
  spec: (typeof KINDS)[number];
  rules: PermissionRules;
  disabled: boolean;
  busy: boolean;
  onChange: (kind: RuleKind, list: string[]) => Promise<string | null>;
}) {
  const { kind } = spec;
  const list = rules[kind];
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const Icon = spec.icon;

  const add = async () => {
    const next = addRule(list, draft);
    if (next.error) return setError(next.error);
    setError(null);
    const failure = await onChange(kind, next.list);
    if (failure) setError(failure);
    else setDraft("");
  };

  const remove = async (rule: string) => {
    setError(null);
    const failure = await onChange(kind, removeRule(list, rule));
    if (failure) setError(failure);
  };

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-card edge" aria-label={`${spec.title} rules`}>
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <Icon className={cn("h-4 w-4", spec.tone)} />
        <h3 className="text-[13px] font-semibold text-fg">{spec.title}</h3>
        <span className="text-[12px] text-muted">{spec.blurb}</span>
        <span className="ml-auto text-[11.5px] tabular text-steel">{list.length}</span>
      </header>
      {list.length === 0 ? (
        <p className="px-4 py-3 text-[12.5px] text-steel">
          No {kind} rules. Example: <code className="font-mono text-muted">{spec.example}</code>
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {list.map((rule) => {
            const also = otherKindsHolding(rules, kind, rule);
            return (
              <li key={rule} className="group flex items-center gap-2 px-4 py-1.5 hover:bg-raised/40">
                <code className="min-w-0 flex-1 break-all font-mono text-[12.5px] text-fg">{rule}</code>
                {also.length > 0 && <Badge tone="warn">also in {also.join(", ")}</Badge>}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={disabled || busy}
                  aria-label={`Remove ${spec.title.toLowerCase()} rule ${rule}`}
                  className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => void remove(rule)}
                >
                  <X />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="flex items-center gap-2 border-t border-line bg-base/30 px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Input
          value={draft}
          disabled={disabled || busy}
          aria-label={`New ${kind} rule`}
          aria-invalid={error ? true : undefined}
          placeholder={spec.example}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          className="h-8 font-mono text-[12.5px]"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={disabled || busy || !draft.trim()}>
          {busy ? <Spinner /> : <Plus />} Add
        </Button>
      </form>
      {error && (
        <div className="px-4 pb-2.5">
          <InlineError message={error} />
        </div>
      )}
    </section>
  );
}

export function ProjectPermissions({
  project,
  files,
  onSaved,
}: {
  project: string;
  files: SettingsFile[];
  onSaved: (file: SettingsFile) => void;
}) {
  const [scope, setScope] = useState<SettingsScope>("shared");
  const [busy, setBusy] = useState(false);
  const file = files.find((f) => f.scope === scope);
  if (!file) return null;
  const locked = file.error !== null;

  const change = async (kind: RuleKind, list: string[]): Promise<string | null> => {
    setBusy(true);
    try {
      onSaved(await api.projectSaveRules(project, scope, { ...file.rules, [kind]: list }));
      return null;
    } catch (e) {
      return errorMessage(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Segmented<SettingsScope>
          aria-label="Settings file"
          value={scope}
          onChange={setScope}
          options={[
            { value: "shared", label: "Shared · settings.json" },
            { value: "local", label: "Local · settings.local.json" },
          ]}
        />
        {file.exists && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void attempt("Couldn't show the file", () => api.openPath(file.path))}
          >
            <FolderOpen /> Reveal file
          </Button>
        )}
      </div>
      <p className="-mt-1 text-[12px] leading-relaxed text-muted">
        {scope === "shared"
          ? "Shared rules live in .claude/settings.json, which projects normally commit so the whole team gets them."
          : "Local rules live in .claude/settings.local.json, which Claude Code keeps out of git. They're yours alone."}{" "}
        {!file.exists && "The file is created when you add your first rule."}
      </p>

      {locked && (
        <div className="rounded-xl border border-err/30 bg-err/8 px-4 py-3">
          <div className="flex items-center gap-2 text-[13px] font-medium text-err">
            <FileLock2 className="h-4 w-4" /> Armada won't edit this file
          </div>
          <p className="mt-1 break-words text-[12.5px] text-muted">{file.error}</p>
          <p className="mt-1 text-[11.5px] text-steel">{prettyPath(file.path)}</p>
        </div>
      )}

      {KINDS.map((spec) => (
        <RuleList
          key={`${scope}:${spec.kind}`}
          spec={spec}
          rules={file.rules}
          disabled={locked}
          busy={busy}
          onChange={change}
        />
      ))}
    </div>
  );
}
