import { useEffect, useState } from "react";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui";
import { OPTION_VARIANT, PermissionSubject } from "@/components/timeline/Permission";
import { respondToPermission } from "@/lib/controller";
import { confirmOption, optionHint, primaryReject } from "@/lib/meta";
import type { Agent, PermissionItem } from "@/lib/types";

/** Every way to answer one request (the agent's own option names), plus "Deny with reason…". Shared by Needs you and the dock. */
export function OptionsSheet({
  entry,
  onClose,
  onDenyWithReason,
}: {
  entry: { agent: Agent; item: PermissionItem } | null;
  onClose: () => void;
  onDenyWithReason: (requestId: string) => void;
}) {
  // Keep showing the last entry while the sheet animates closed.
  const [shown, setShown] = useState(entry);
  useEffect(() => {
    if (entry) setShown(entry);
  }, [entry]);
  const e = entry ?? shown;
  return (
    <Sheet open={!!entry} onClose={onClose} title={e?.item.title ?? "Options"} description={e ? `${e.agent.title}` : undefined}>
      {e && (
        <div className="space-y-4">
          <div data-noswipe className="space-y-2">
            <PermissionSubject item={e.item} compact />
          </div>
          <div className="space-y-2" role="group" aria-label="Choose a response">
            {e.item.options.map((o) => (
              <Button
                key={o.id}
                size="lg"
                variant={OPTION_VARIANT[o.kind]}
                className="h-auto min-h-[56px] w-full flex-col !items-start gap-0 py-2.5 text-left"
                onClick={async () => {
                  onClose();
                  if (await confirmOption(o)) void respondToPermission(e.agent.id, e.item.requestId, o.id);
                }}
              >
                <span className="block w-full truncate">{o.name}</span>
                <span className="block w-full truncate text-[12.5px] font-normal opacity-75">{optionHint(o)}</span>
              </Button>
            ))}
            {primaryReject(e.item) && (
              <Button size="lg" variant="ghost" icon="pencil" className="w-full" onClick={() => onDenyWithReason(e.item.requestId)}>
                Deny with reason…
              </Button>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}
