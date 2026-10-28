import { CalendarClock, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { HeaderAction, PageHeader } from "@/components/PageHeader";
import { blankSchedule, ScheduleDialog } from "@/components/schedules/ScheduleDialog";
import { ScheduleRow } from "@/components/schedules/ScheduleRow";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { nextRun, sortSchedules, untilLabel } from "@/lib/schedules";
import type { Schedule } from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { useNow } from "@/hooks/useNow";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";

export function SchedulesView() {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [toggling, setToggling] = useState<Record<string, boolean>>({});
  const accounts = useApp((s) => s.accounts);
  const agents = useApp((s) => s.agents);
  const openAgent = useUi((s) => s.openAgent);
  const now = useNow();

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setSchedules(await api.listSchedules());
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const upsert = useCallback((s: Schedule) => {
    setSchedules((list) => {
      if (!list) return [s];
      const i = list.findIndex((x) => x.id === s.id);
      if (i < 0) return [...list, s];
      const next = list.slice();
      next[i] = s;
      return next;
    });
  }, []);

  const sorted = useMemo(() => (schedules ? sortSchedules(schedules, new Date(now)) : []), [schedules, now]);
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const toggle = async (s: Schedule, enabled: boolean) => {
    upsert({ ...s, enabled });
    setToggling((t) => ({ ...t, [s.id]: true }));
    try {
      upsert(await api.saveSchedule({ ...s, enabled }));
    } catch (e) {
      upsert(s);
      toast.error(`Couldn't ${enabled ? "enable" : "pause"} “${s.name}”`, { description: errorMessage(e) });
    } finally {
      setToggling((t) => ({ ...t, [s.id]: false }));
    }
  };

  const run = async (s: Schedule) => {
    setRunning((r) => ({ ...r, [s.id]: true }));
    try {
      const agent = await api.runSchedule(s.id);
      useApp.getState().upsertAgent(agent);
      upsert({ ...s, lastRunAt: Date.now(), lastAgentId: agent.id });
      toast.success(`Started “${s.name}”`, {
        description: agent.title,
        action: { label: "Open", onClick: () => openAgent(agent.id) },
      });
      // Pick up whatever the backend recorded about the run.
      api
        .listSchedules()
        .then(setSchedules)
        .catch(() => {});
    } catch (e) {
      toast.error(`Couldn't run “${s.name}”`, { description: errorMessage(e) });
    } finally {
      setRunning((r) => ({ ...r, [s.id]: false }));
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const target = deleting;
    setDeleteBusy(true);
    try {
      await api.deleteSchedule(target.id);
      setSchedules((list) => list?.filter((x) => x.id !== target.id) ?? null);
      toast(`Deleted “${target.name}”`);
      setDeleting(null);
    } catch (e) {
      toast.error("Couldn't delete schedule", { description: errorMessage(e) });
    } finally {
      setDeleteBusy(false);
    }
  };

  const activeCount = schedules?.filter((s) => s.enabled).length ?? 0;
  const soonest = sorted.find((s) => s.enabled);
  const soonestAt = soonest ? nextRun(soonest, new Date(now)) : null;

  const subtitle =
    schedules && schedules.length > 0
      ? `${activeCount} of ${schedules.length} active${soonest && soonestAt ? ` · next: ${soonest.name} ${untilLabel(soonestAt, now)}` : ""}`
      : "Start agents automatically on a timetable.";

  return (
    <div className="@container flex h-full flex-col">
      <PageHeader
        icon={<CalendarClock />}
        title="Schedules"
        subtitle={subtitle}
        right={
          <HeaderAction
            variant="primary"
            icon={<Plus />}
            label="New schedule"
            onClick={() => setEditing(blankSchedule())}
          />
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1040px] flex-1 flex-col px-4 pb-10 pt-4 @2xl:px-6 @2xl:pb-16 @2xl:pt-6">
          {loadError ? (
            <div
              role="alert"
              className="flex items-center gap-3 rounded-xl border border-err/30 bg-err/[0.06] px-4 py-3 text-[13px]"
            >
              <span className="min-w-0 flex-1 text-err">
                Couldn't load schedules: <span className="selectable font-mono text-[12px]">{loadError}</span>
              </span>
              <Button size="sm" variant="secondary" onClick={() => void load()}>
                <RefreshCw className="!h-3.5 !w-3.5" /> Retry
              </Button>
            </div>
          ) : schedules === null ? (
            <ul className="space-y-2.5" aria-label="Loading schedules" aria-busy>
              {[0, 1, 2].map((i) => (
                <li key={i} className="flex items-center gap-4 rounded-xl border border-line bg-card px-4 py-4">
                  <Skeleton className="h-[26px] w-[26px] rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-48" />
                    <Skeleton className="h-3 w-72 max-w-full" />
                  </div>
                  <Skeleton className="h-8 w-40 rounded-lg" />
                </li>
              ))}
            </ul>
          ) : sorted.length === 0 ? (
            <EmptyState
              className="my-auto py-12"
              icon={<CalendarClock />}
              title="No schedules yet"
              description="Have an agent audit dependencies every night, triage issues each morning, or draft a weekly changelog. It starts on its own and pings you when it's done."
              action={
                <Button variant="primary" onClick={() => setEditing(blankSchedule())}>
                  <Plus /> New schedule
                </Button>
              }
            />
          ) : (
            <ul className="space-y-2.5" aria-label="Schedules">
              {sorted.map((s) => (
                <ScheduleRow
                  key={s.id}
                  schedule={s}
                  account={accountMap.get(s.accountId)}
                  lastAgent={s.lastAgentId ? agents[s.lastAgentId] : undefined}
                  now={now}
                  running={running[s.id] ?? false}
                  toggling={toggling[s.id] ?? false}
                  onToggle={(v) => void toggle(s, v)}
                  onRun={() => void run(s)}
                  onEdit={() => setEditing(s)}
                  onDelete={() => setDeleting(s)}
                  onOpenAgent={openAgent}
                />
              ))}
            </ul>
          )}
          {schedules !== null && !loadError && (
            <p className="mt-6 text-center text-[11.5px] text-steel">
              Times are local. Schedules run while Armada is running, including when it's minimized to the tray.
            </p>
          )}
        </div>
      </div>

      <ScheduleDialog schedule={editing} onClose={() => setEditing(null)} onSaved={upsert} />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && !deleteBusy && setDeleting(null)}
        danger
        busy={deleteBusy}
        title="Delete schedule?"
        description={deleting ? <>“{deleting.name}” will stop running. Agents it already started are kept.</> : null}
        confirmLabel="Delete schedule"
        onConfirm={confirmDelete}
      />
    </div>
  );
}
