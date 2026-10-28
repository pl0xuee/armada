import { useState, type ReactNode } from "react";
import { installUpdate } from "@/lib/actions";
import { useApp } from "@/store/app";
import { ConfirmDialog } from "../ui/alert-dialog";

function workingCount(): number {
  let n = 0;
  for (const a of Object.values(useApp.getState().agents)) {
    if (a.status === "working" || a.status === "starting" || a.status === "needs_permission") n++;
  }
  return n;
}

/**
 * "Install & restart" that warns first when agents are mid-turn (restarting stops their turns).
 * Returns a `request` to call from buttons and the confirm `dialog` to render once.
 */
export function useGuardedInstall(): { request: () => void; dialog: ReactNode } {
  const [working, setWorking] = useState<number | null>(null);
  const request = () => {
    const n = workingCount();
    if (n === 0) void installUpdate();
    else setWorking(n);
  };
  const dialog = (
    <ConfirmDialog
      open={working !== null}
      onOpenChange={(o) => !o && setWorking(null)}
      title="Install the update now?"
      description={
        working !== null && (
          <>
            {working === 1 ? "1 agent is" : `${working} agents are`} working. Restarting stops{" "}
            {working === 1 ? "its turn" : "their turns"}; {working === 1 ? "it resumes" : "they resume"} after the
            update.
          </>
        )
      }
      confirmLabel="Install now"
      cancelLabel="Later"
      onConfirm={() => {
        setWorking(null);
        void installUpdate();
      }}
    />
  );
  return { request, dialog };
}
