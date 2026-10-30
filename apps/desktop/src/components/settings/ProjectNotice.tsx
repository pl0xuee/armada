import { CircleAlert } from "lucide-react";

/** Inline error under a project-settings control (same look as FieldError, not tied to a settings field). */
export function InlineError({ message }: { message: string }) {
  return (
    <p role="alert" className="mt-2 flex items-start gap-1.5 text-[11.5px] text-err">
      <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="break-words">{message}</span>
    </p>
  );
}
