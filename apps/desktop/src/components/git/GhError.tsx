import { detailsText, splitDetails } from "@/lib/ghError";
import { cn } from "@/lib/utils";
import { CopyButton } from "../CopyButton";

/**
 * A failed GitHub action: the readable sentence, and a "Copy details" button that carries gh's
 * own words (and what was being done) for a bug report.
 */
export function GhError({ text, context, className }: { text: string; context?: string; className?: string }) {
  const { message } = splitDetails(text);
  return (
    <div
      role="alert"
      className={cn("rounded-lg border border-err/30 bg-err/[0.07] px-2.5 py-2 text-caption text-err", className)}
    >
      <p className="selectable break-words">{message}</p>
      <CopyButton
        text={detailsText(text, context)}
        label="Copy details"
        className="-ml-1.5 mt-1 h-5 text-micro text-err/80 hover:bg-err/10 hover:text-err"
      />
    </div>
  );
}
