import { useState } from "react";
import { copyText } from "@/lib/clipboard";
import { currentPairingLink, pushToast } from "@/lib/controller";
import { isIOS, isStandalone } from "@/lib/platform";
import { storage } from "@/lib/storage";
import { Icon } from "./Icon";
import { Button } from "./ui";

const DISMISSED = "armada.tip.install";

/** Whether the "Install on iPhone" tip applies (iOS Safari, not yet installed). */
export function installTipApplies(): boolean {
  return isIOS() && !isStandalone();
}

/**
 * iOS gives a Home Screen app its own, empty storage, so the pairing doesn't
 * carry over from Safari. Explain that and make re-pairing one paste.
 */
export function InstallTip({ dismissible = true }: { dismissible?: boolean }) {
  const [hidden, setHidden] = useState(() => dismissible && storage.get(DISMISSED) === "1");
  if (!installTipApplies() || hidden) return null;
  const link = currentPairingLink();
  return (
    <section aria-label="Install on iPhone" className="rounded-2xl border border-accent/30 bg-accent/[0.06] p-3.5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-accent/15 text-accent">
          <Icon name="phone" size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] font-semibold text-fg">Install on iPhone</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
            Tap Share, then <span className="text-fg">Add to Home Screen</span>. The Home Screen app has its own storage, so open it and paste
            your pairing link once.
          </p>
        </div>
        {dismissible && (
          <button
            type="button"
            aria-label="Dismiss tip"
            onClick={() => {
              storage.set(DISMISSED, "1");
              setHidden(true);
            }}
            className="press -mt-1.5 -mr-1.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-steel"
          >
            <Icon name="x" size={17} />
          </button>
        )}
      </div>
      {link && (
        <Button
          size="sm"
          variant="secondary"
          icon="copy"
          className="mt-3 w-full"
          onClick={async () => {
            const ok = await copyText(link);
            pushToast({
              tone: ok ? "ok" : "err",
              title: ok ? "Pairing link copied" : "Couldn't copy the link",
              body: ok ? "Keep it private: anyone with it can control your agents." : null,
              agentId: null,
              reason: null,
              duration: 4_000,
            });
          }}
        >
          Copy pairing link
        </Button>
      )}
    </section>
  );
}
