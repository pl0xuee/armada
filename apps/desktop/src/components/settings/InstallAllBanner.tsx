import { Download, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { installMissing } from "@/lib/actions";
import type { ProviderInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { providerReady } from "./ProviderCard";

/** Prominent one-click installer, shown only while something is missing. */
export function InstallAllBanner({ providers, className }: { providers: ProviderInfo[]; className?: string }) {
  const missing = providers.filter((p) => !providerReady(p));
  if (missing.length === 0) return null;
  const names = missing.map((p) => p.displayName);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return (
    <div
      className={cn(
        "relative flex items-center gap-4 overflow-hidden rounded-xl border border-accent/30 bg-accent/[0.06] p-4 edge",
        className,
      )}
    >
      <div
        className="pointer-events-none absolute -left-10 -top-12 h-32 w-32 rounded-full bg-accent/15 blur-2xl"
        aria-hidden
      />
      <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/30 bg-accent/10 text-accent">
        <Download className="h-[18px] w-[18px]" />
      </span>
      <div className="relative min-w-0 flex-1">
        <p className="text-[13.5px] font-medium text-fg">
          {list} {missing.length === 1 ? "isn't" : "aren't"} ready yet
        </p>
        <p className="mt-0.5 flex items-start gap-1.5 text-[12px] leading-relaxed text-muted">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />
          Armada installs what's missing. No admin rights needed; if Node.js isn't installed it downloads a private
          copy.
        </p>
      </div>
      <Button variant="primary" className="relative" onClick={() => void installMissing()}>
        <Download /> Install everything
      </Button>
    </div>
  );
}
