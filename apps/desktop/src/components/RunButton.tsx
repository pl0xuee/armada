import { ChevronDown, ClipboardPaste, Play } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { commandTitle, isDestructive, ptyPayload } from "@/lib/shellRun";
import { cn, errorMessage } from "@/lib/utils";
import { runInNewTerminal } from "@/store/workspace";

const btn =
  "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-steel transition-colors hover:bg-raised hover:text-fg";

/** Run a shell code block in a new terminal of the agent's workspace panel (see runInNewTerminal). */
export function RunButton({
  agentId,
  command,
  runRef,
}: {
  agentId: string;
  command: string;
  runRef?: (fn: () => void) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const go = async (run: boolean) => {
    try {
      await runInNewTerminal(agentId, commandTitle(command), ptyPayload(command, run));
    } catch (e) {
      toast.error(run ? "Couldn't run the command" : "Couldn't paste the command", { description: errorMessage(e) });
    }
  };
  const click = () => (isDestructive(command) ? setConfirm(true) : void go(true));
  runRef?.(click);
  return (
    <div className="flex items-center">
      <Popover open={confirm} onOpenChange={setConfirm}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Run in terminal"
            title="Run in a new terminal tab (Ctrl/Cmd+Enter when focused)"
            onClick={(e) => {
              e.stopPropagation();
              click();
            }}
            className={btn}
          >
            <Play className="h-3.5 w-3.5" />
            <span>Run</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80">
          <p className="mb-2 font-medium">This command can change or delete things. Run it?</p>
          <pre className="selectable mb-3 max-h-40 overflow-auto rounded-lg border border-line bg-code p-2 font-mono text-[12px] leading-[1.5] whitespace-pre-wrap break-all">
            {command}
          </pre>
          <div className="flex justify-end gap-2">
            <PopoverClose className={cn(btn, "h-7 px-2.5 text-[12px]")}>Cancel</PopoverClose>
            <PopoverClose
              onClick={() => void go(true)}
              className="inline-flex h-7 items-center rounded-md bg-err/15 px-2.5 text-[12px] font-medium text-err transition-colors hover:bg-err/25"
            >
              Run
            </PopoverClose>
          </div>
        </PopoverContent>
      </Popover>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="More run options" className={cn(btn, "-ml-1 px-1")}>
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[180px]">
          <DropdownMenuItem onSelect={() => void go(false)}>
            <ClipboardPaste /> Paste without running
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
