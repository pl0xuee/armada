import { FolderOpen, FolderPlus } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { pickFolder } from "@/lib/window";
import { errorMessage, prettyPath } from "@/lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "./ui/dialog";
import { Input, Label } from "./ui/input";
import { Spinner } from "./ui/misc";
import { Switch } from "./ui/switch";

const PARENT_KEY = "kvistcode.newProjectParent";

/** Joins for display only; the real path is made in Rust. */
const joinPath = (parent: string, name: string) => `${parent.replace(/[\\/]+$/, "")}/${name}`;

/** "New project…": makes a folder (and a git repo, by default) and hands its path back. */
export function NewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new folder's path once it exists. */
  onCreated: (path: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New project"
        description="Kvistcode makes the folder for you. Your agent starts working inside it."
        onOpenAutoFocus={(e) => {
          // Radix would pick the close button; the name is what you type first.
          e.preventDefault();
          document.getElementById("np-name")?.focus();
        }}
      >
        {open && <Body onClose={() => onOpenChange(false)} onCreated={onCreated} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({ onClose, onCreated }: { onClose: () => void; onCreated: (path: string) => void }) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState(() => {
    try {
      return localStorage.getItem(PARENT_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [git, setGit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    if (parent) return;
    let alive = true;
    api
      .defaultProjectsFolder()
      .then((p) => alive && setParent((cur) => cur || p))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // Only the first fill: after that the user's own choice wins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const browse = async () => {
    const p = await pickFolder(parent || undefined);
    if (p) setParent(p);
  };

  const trimmed = name.trim();
  const canCreate = !!trimmed && !!parent.trim() && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canCreate || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const made = await api.createProject(parent.trim(), trimmed, git);
      try {
        localStorage.setItem(PARENT_KEY, parent.trim());
      } catch {
        /* storage unavailable: the default is used next time */
      }
      if (made.note) toast(made.note);
      onCreated(made.path);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)}>
      <DialogBody className="space-y-4">
        <div>
          <Label htmlFor="np-name">Project name</Label>
          <Input
            id="np-name"
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            placeholder="my-new-app"
            maxLength={100}
            aria-invalid={!!error}
            aria-describedby={error ? "np-error" : undefined}
          />
        </div>
        <div>
          <Label htmlFor="np-parent">Where to put it</Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <FolderOpen className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-steel" />
              <Input
                id="np-parent"
                value={parent}
                onChange={(e) => {
                  setParent(e.target.value);
                  setError(null);
                }}
                placeholder="/path/to/folder"
                className="pl-9 font-mono text-small"
              />
            </div>
            <Button type="button" variant="secondary" className="h-9" onClick={() => void browse()}>
              Browse…
            </Button>
          </div>
          {trimmed && parent.trim() && (
            <p className="selectable mt-1.5 truncate font-mono text-micro text-steel" title={joinPath(parent, trimmed)}>
              {prettyPath(joinPath(parent.trim(), trimmed))}
            </p>
          )}
        </div>
        <div className="flex items-start gap-3">
          <Switch id="np-git" checked={git} onCheckedChange={setGit} aria-label="Track changes with git" />
          <label htmlFor="np-git" className="min-w-0 cursor-pointer">
            <span className="block text-body text-fg">Track changes with git</span>
            <span className="block text-caption leading-snug text-muted">
              Recommended. It lets several agents work in the same project without overwriting each other.
            </span>
          </label>
        </div>
        {error && (
          <p id="np-error" role="alert" className="text-small text-err">
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!canCreate}>
          {busy ? <Spinner className="text-current" /> : <FolderPlus />}
          Create project
        </Button>
      </DialogFooter>
    </form>
  );
}
