import { Icon } from "../Icon";

/** The card's buttons live in the dock above the message box while that request is open. */
export function DockedNote() {
  return (
    <p className="flex items-center gap-2 rounded-xl bg-raised px-3 py-2.5 text-[13px] text-muted">
      <Icon name="arrowDown" size={16} className="shrink-0 text-steel" />
      Answer in the panel below the conversation.
    </p>
  );
}
