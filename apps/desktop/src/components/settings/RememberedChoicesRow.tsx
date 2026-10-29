import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { rememberedGroups } from "@/lib/configMemory";
import { errorMessage } from "@/lib/utils";
import { useApp } from "@/store/app";
import { SettingRow } from "./SettingRow";

/** What new agents start with, per provider, from the user's last composer choices. */
export function RememberedChoicesRow() {
  const customAgents = useApp((s) => s.settings?.customAgents);
  const [defaults, setDefaults] = useState<Record<string, Record<string, string>>>({});

  useEffect(() => {
    let live = true;
    void api.configDefaults().then((d) => live && setDefaults(d), () => {});
    return () => {
      live = false;
    };
  }, []);

  const groups = rememberedGroups(defaults, customAgents);
  const [alsoAgents, setAlsoAgents] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const reset = async () => {
    setConfirmOpen(false);
    try {
      setDefaults(await api.clearConfigDefaults(undefined, alsoAgents || undefined));
    } catch (e) {
      toast.error(`Couldn't reset remembered choices: ${errorMessage(e)}`);
    }
  };

  return (
    <SettingRow
      stack
      title="Remembered composer choices"
      description="New agents start with the model, effort and other options you last picked for that provider. Permission mode is never remembered."
    >
      {groups.length === 0 ? (
        <p className="text-[12px] text-steel">Nothing yet — change an option in a composer to remember it.</p>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <ul className="min-w-0 space-y-1 text-[12px] text-muted">
            {groups.map((g) => (
              <li key={g.key} className="truncate">
                <span className="text-fg">{g.label}</span>
                {": "}
                {g.entries.map((e) => `${e.id} ${e.value}`).join(" · ")}
              </li>
            ))}
          </ul>
          <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" aria-label="Reset remembered composer choices">
                Reset
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="space-y-3">
              <p className="text-fg">Reset the defaults new agents start with?</p>
              <label className="flex cursor-pointer items-start gap-2 text-[12px] text-muted">
                <Checkbox
                  checked={alsoAgents}
                  onCheckedChange={setAlsoAgents}
                  className="mt-0.5"
                  aria-label="Also reset each agent's saved choices"
                />
                <span>Also reset each agent's saved choices</span>
              </label>
              <div className="flex justify-end gap-2">
                <PopoverClose asChild>
                  <Button size="sm" variant="ghost">
                    Cancel
                  </Button>
                </PopoverClose>
                <Button size="sm" onClick={() => void reset()}>
                  {alsoAgents ? "Reset all" : "Reset defaults"}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      )}
    </SettingRow>
  );
}
