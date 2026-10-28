import { ArrowDownToLine, ExternalLink, FileText, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { installUpdate } from "@/lib/actions";
import { api } from "@/lib/api";
import { useApp } from "@/store/app";
import { Markdown } from "./Markdown";
import { Button } from "./ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "./ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/** Title-bar pill announcing an app update, with install progress. */
export function UpdatePill() {
  const update = useApp((s) => s.update);
  const dismissed = useApp((s) => s.updateDismissed);
  const progress = useApp((s) => s.updateProgress);
  const [notesOpen, setNotesOpen] = useState(false);
  const [open, setOpen] = useState(false);

  if (!update || (dismissed && !progress)) return null;

  const installing = progress !== null;
  const ratio = progress?.total ? Math.min(1, progress.downloaded / progress.total) : null;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Armada ${update.version} is available`}
            className="relative flex h-[24px] items-center gap-1.5 overflow-hidden rounded-full border border-accent/40 bg-accent/10 pl-2 pr-2.5 text-[11.5px] font-medium text-accent transition-colors hover:bg-accent/15"
          >
            {installing ? (
              <>
                <span
                  className="absolute inset-y-0 left-0 origin-left bg-accent/20 transition-transform duration-200"
                  style={{ width: "100%", transform: `scaleX(${ratio ?? 0.15})` }}
                  aria-hidden
                />
                <ArrowDownToLine className="relative h-3.5 w-3.5 animate-breathe" />
                <span className="relative tabular">
                  {ratio !== null ? `Updating ${Math.round(ratio * 100)}%` : "Updating…"}
                </span>
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                <span>Update {update.version}</span>
              </>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-0">
          <div className="flex items-start gap-3 p-3.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent">
              <Sparkles className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold">Armada {update.version} is available</div>
              <div className="text-[12px] text-muted">
                You have {update.currentVersion}
                {update.date ? ` · released ${new Date(update.date).toLocaleDateString()}` : ""}
              </div>
            </div>
            {!installing && (
              <button
                type="button"
                aria-label="Dismiss update"
                onClick={() => {
                  useApp.setState({ updateDismissed: true });
                  setOpen(false);
                }}
                className="rounded-md p-1 text-steel hover:bg-gunmetal hover:text-fg"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {installing && (
            <div className="px-3.5 pb-3">
              <div className="h-1.5 overflow-hidden rounded-full bg-base">
                <div
                  className={
                    ratio === null
                      ? "shimmer-bar h-full w-full"
                      : "h-full origin-left rounded-full bg-accent transition-transform duration-200"
                  }
                  style={ratio === null ? undefined : { transform: `scaleX(${ratio})` }}
                />
              </div>
              <p className="mt-1.5 text-[11.5px] text-steel">
                Armada restarts automatically when the update is installed.
              </p>
            </div>
          )}
          <div className="flex items-center gap-2 border-t border-line px-3.5 py-2.5">
            {update.notes && (
              <Button size="sm" variant="ghost" onClick={() => setNotesOpen(true)}>
                <FileText /> Release notes
              </Button>
            )}
            <div className="ml-auto" />
            {update.canInstall ? (
              <Button size="sm" variant="primary" disabled={installing} onClick={() => void installUpdate()}>
                <ArrowDownToLine /> Install & restart
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={() => void api.openPath(update.url)}>
                <ExternalLink /> Download
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>

      <Dialog open={notesOpen} onOpenChange={setNotesOpen}>
        <DialogContent title={`What's new in ${update.version}`} description={update.url}>
          <DialogBody>
            <Markdown text={update.notes ?? "No release notes."} />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => void api.openPath(update.url)}>
              <ExternalLink /> View on GitHub
            </Button>
            {update.canInstall && (
              <Button
                variant="primary"
                disabled={installing}
                onClick={() => {
                  setNotesOpen(false);
                  void installUpdate();
                }}
              >
                <ArrowDownToLine /> Install & restart
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
