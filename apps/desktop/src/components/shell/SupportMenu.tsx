import { Bug, Compass, Heart, HandHeart, Keyboard, LifeBuoy, ScrollText } from "lucide-react";
import { openExternal } from "@/lib/external";
import { modKey } from "@/lib/utils";
import { useApp } from "@/store/app";
import { openTour } from "@/store/tour";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import { openShortcutHelp } from "./ShortcutHelp";

const REPO = "https://github.com/pl0xuee/kvistcode";

/** A new GitHub issue with the version and OS filled in (nothing else about the machine). */
export function reportProblemUrl(version: string, platform: string): string {
  const os = platform === "macos" ? "macOS" : platform === "windows" ? "Windows" : "Linux";
  const body = [
    "**What happened**",
    "",
    "",
    "**What you expected**",
    "",
    "",
    "---",
    `Kvistcode ${version || "dev"} on ${os}`,
  ].join("\n");
  return `${REPO}/issues/new?${new URLSearchParams({ body }).toString()}`;
}

/** Help and ways to support Kvistcode, from the title bar. */
export function SupportMenu({ compact }: { compact: boolean }) {
  const version = useApp((s) => s.version);
  const platform = useApp((s) => s.platform);
  const open = (url: string) => void openExternal(url);
  return (
    <DropdownMenu>
      <Tooltip content="Help and support" side="bottom">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Help and support"
            className="flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-1.5 text-caption text-steel transition-colors hover:bg-raised hover:text-fg data-[state=open]:bg-raised data-[state=open]:text-fg"
          >
            <LifeBuoy className="h-3.5 w-3.5" />
            {!compact && <span>Support</span>}
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-[248px]">
        <DropdownMenuLabel>Get help</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => open(reportProblemUrl(version, platform))}>
          <Bug /> Report a problem
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => open(`${REPO}/releases`)}>
          <ScrollText /> What's new
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openShortcutHelp()} shortcut={`${modKey} /`}>
          <Keyboard /> Keyboard shortcuts
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openTour()}>
          <Compass /> Take the tour
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Support Kvistcode</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => open("https://github.com/sponsors/pl0xuee")}>
          <Heart /> Sponsor on GitHub
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => open("https://kvistcode.com/support/")}>
          <HandHeart /> Other ways to support
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
