import { settleConfirm } from "@/lib/confirm";
import { useStore } from "@/lib/store";
import { Sheet } from "./Sheet";
import { Button } from "./ui";

/** Renders the pending confirmation (see `confirmAction`) as a bottom sheet. */
export function ConfirmHost() {
  const req = useStore((s) => s.confirm);
  return (
    <Sheet open={!!req} onClose={() => settleConfirm(false)} title={req?.title ?? ""}>
      {req && (
        <>
          {req.body && <p className="text-[14.5px] leading-relaxed text-muted">{req.body}</p>}
          <div className="mt-5 grid grid-cols-2 gap-2">
            <Button variant="secondary" size="lg" onClick={() => settleConfirm(false)}>
              Cancel
            </Button>
            <Button variant={req.destructive ? "danger" : "primary"} size="lg" onClick={() => settleConfirm(true)} autoFocus>
              {req.confirmLabel}
            </Button>
          </div>
        </>
      )}
    </Sheet>
  );
}
