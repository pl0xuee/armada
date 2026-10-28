import { describe, expect, it } from "vitest";
import { fieldForError, fieldsOf } from "./settingsErrors";

describe("fieldForError", () => {
  it("routes backend validation messages to their field", () => {
    expect(fieldForError("Unknown failover setting “x”")).toBe("failover");
    expect(fieldForError("Unknown permission mode “x”")).toBe("permissionMode");
    expect(fieldForError("The remote control port must be between 1 and 65535")).toBe("port");
    expect(fieldForError("Quiet hours must be times like 22:00 (00:00 to 23:59), not “7pm”")).toBe("quietHours");
    expect(fieldForError("Phone push URL: include a topic")).toBe("ntfy");
    expect(fieldForError("disk full")).toBeNull();
  });
  it("maps patch keys to fields", () => {
    expect(fieldsOf({ ntfyUrl: null, failover: "ask" })).toEqual(["failover", "ntfy"]);
  });
});
