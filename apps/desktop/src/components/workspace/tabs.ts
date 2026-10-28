import { Globe, ListChecks, SquareTerminal, type LucideIcon } from "lucide-react";
import { lazy, type ComponentType } from "react";
import type { Agent } from "@/lib/types";
import { ScriptsTab } from "./ScriptsTab";

// xterm is large: load it when a terminal is first shown, not with the app.
const TerminalTab = lazy(() => import("./TerminalTab").then((m) => ({ default: m.TerminalTab })));

const PreviewTab = lazy(() => import("./PreviewTab").then((m) => ({ default: m.PreviewTab })));

export interface WorkspaceTabDef {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Rendered inside the panel body; owns any toolbar it needs. `active` is false only when kept mounted. */
  Component: ComponentType<{ agent: Agent }>;
}

/** Tabs of the workspace panel, in order. Add a new entry here (e.g. "Preview") to extend the panel. */
export const WORKSPACE_TABS: WorkspaceTabDef[] = [
  { id: "terminal", label: "Terminal", icon: SquareTerminal, Component: TerminalTab },
  { id: "scripts", label: "Scripts", icon: ListChecks, Component: ScriptsTab },
  { id: "preview", label: "Preview", icon: Globe, Component: PreviewTab },
];
