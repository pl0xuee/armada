import { describe, expect, it } from "vitest";
import { errorMessage } from "./utils";

describe("errorMessage", () => {
  it("passes strings and Error messages through", () => {
    expect(errorMessage("Couldn't reach the core")).toBe("Couldn't reach the core");
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("reads the message of a plain error object instead of printing JSON", () => {
    expect(errorMessage({ message: "Permission denied", code: 13 })).toBe("Permission denied");
    expect(errorMessage({ error: "Not found" })).toBe("Not found");
  });

  it("never returns undefined for nothing or for an empty error", () => {
    expect(errorMessage(undefined)).toBe("Something went wrong");
    expect(errorMessage(null)).toBe("Something went wrong");
    expect(errorMessage(new Error(""))).toBe("Error");
    expect(typeof errorMessage(() => 1)).toBe("string");
  });
});
