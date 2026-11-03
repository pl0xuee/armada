import { describe, expect, it } from "vitest";
import { reportProblemUrl } from "./SupportMenu";

describe("Report a problem", () => {
  it("opens a new issue with only the version and OS filled in", () => {
    const url = new URL(reportProblemUrl("0.4.2", "macos"));
    expect(url.origin + url.pathname).toBe("https://github.com/pl0xuee/kvistcode/issues/new");
    expect([...url.searchParams.keys()]).toEqual(["body"]);
    expect(url.searchParams.get("body")).toContain("Kvistcode 0.4.2 on macOS");
  });

  it("says dev when there is no version yet", () => {
    expect(new URL(reportProblemUrl("", "linux")).searchParams.get("body")).toContain("Kvistcode dev on Linux");
  });
});
