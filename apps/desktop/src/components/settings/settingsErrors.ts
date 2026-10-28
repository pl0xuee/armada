// Backend validation errors from update_settings, routed to the field they're about.
import { create } from "zustand";
import type { Settings } from "@/lib/types";
import { useApp } from "@/store/app";

export type SettingsField = "failover" | "permissionMode" | "port" | "quietHours" | "ntfy";

/** Which field a backend error message belongs to (by its prefix). */
export function fieldForError(message: string): SettingsField | null {
  if (/^Unknown failover/i.test(message)) return "failover";
  if (/^Unknown permission mode/i.test(message)) return "permissionMode";
  if (/^The remote control port/i.test(message)) return "port";
  if (/^Quiet hours/i.test(message)) return "quietHours";
  if (/^Phone push URL:/i.test(message)) return "ntfy";
  return null;
}

/** Fields a settings patch touches (a successful save clears their errors). */
export function fieldsOf(patch: Partial<Settings>): SettingsField[] {
  const out: SettingsField[] = [];
  if ("failover" in patch) out.push("failover");
  if ("defaultPermissionMode" in patch) out.push("permissionMode");
  if ("remote" in patch) out.push("port");
  if ("quietHours" in patch) out.push("quietHours");
  if ("ntfyUrl" in patch) out.push("ntfy");
  return out;
}

interface SettingsErrors {
  errors: Partial<Record<SettingsField, string>>;
  set: (field: SettingsField, message: string) => void;
  clear: (fields: SettingsField[]) => void;
}

export const useSettingsErrors = create<SettingsErrors>((set) => ({
  errors: {},
  set: (field, message) => set((s) => ({ errors: { ...s.errors, [field]: message } })),
  clear: (fields) =>
    set((s) => {
      if (!fields.some((f) => f in s.errors)) return s;
      const errors = { ...s.errors };
      for (const f of fields) delete errors[f];
      return { errors };
    }),
}));

export function useFieldError(field: SettingsField): string | undefined {
  return useSettingsErrors((s) => s.errors[field]);
}

/**
 * Save a settings patch. Store rolls back on failure; a validation error is shown inline on its
 * field (returns false), anything else via the caller's fallback.
 */
export async function saveSettingsPatch(
  patch: Partial<Settings>,
  onOtherError: (message: string) => void,
): Promise<boolean> {
  try {
    await useApp.getState().patchSettings(patch);
    useSettingsErrors.getState().clear(fieldsOf(patch));
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const field = fieldForError(message);
    if (field) useSettingsErrors.getState().set(field, message);
    else onOtherError(message);
    return false;
  }
}

/** id of the inline error element (for aria-describedby). */
export function fieldErrorId(field: SettingsField) {
  return `settings-error-${field}`;
}
