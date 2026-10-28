import { CircleAlert } from "lucide-react";
import { fieldErrorId, useFieldError, type SettingsField } from "./settingsErrors";

/** Backend validation error for a settings field, shown right under the control. */
export function FieldError({ field }: { field: SettingsField }) {
  const error = useFieldError(field);
  if (!error) return null;
  return (
    <p id={fieldErrorId(field)} role="alert" className="mt-1.5 flex items-start gap-1.5 text-[11.5px] text-err">
      <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="break-words">{error}</span>
    </p>
  );
}
