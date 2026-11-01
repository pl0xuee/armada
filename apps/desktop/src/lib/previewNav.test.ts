import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ api: { probePorts: vi.fn(async (p: number[]) => p) } }));

import { autoSelect } from "@/store/preview";
import { parseAgentMessage } from "./previewBridge";
import { devUrlFromPage } from "./previewNav";

const PROXY = "http://127.0.0.1:51234";
const DEV = "http://localhost:3000";

describe("devUrlFromPage", () => {
  it("maps the page's path, query and hash onto the dev server", () => {
    expect(devUrlFromPage(`${PROXY}/docs/intro?x=1#top`, PROXY, DEV)).toBe("http://localhost:3000/docs/intro?x=1#top");
    expect(devUrlFromPage(`${PROXY}/`, PROXY, DEV)).toBe("http://localhost:3000/");
  });
  it("ignores a page that is not on the proxy origin", () => {
    expect(devUrlFromPage("http://evil.example/steal", PROXY, DEV)).toBeNull();
    expect(devUrlFromPage("http://127.0.0.1:9/", PROXY, DEV)).toBeNull();
    expect(devUrlFromPage("javascript:alert(1)", PROXY, DEV)).toBeNull();
    expect(devUrlFromPage("not a url", PROXY, DEV)).toBeNull();
  });
  it("never produces a non-loopback address, whatever the dev origin", () => {
    expect(devUrlFromPage(`${PROXY}/x`, PROXY, "http://example.com")).toBeNull();
  });
  it("cannot be steered to another host by a crafted path", () => {
    expect(devUrlFromPage(`${PROXY}//evil.example/x`, PROXY, DEV)).toBe("http://localhost:3000//evil.example/x");
    expect(devUrlFromPage(`${PROXY}/@evil.example/`, PROXY, DEV)).toBe("http://localhost:3000/@evil.example/");
  });
});

describe("nav messages", () => {
  const msg = (o: Record<string, unknown>) => ({ kvistcode: "preview", v: 1, token: "t", type: "nav", ...o });
  it("parses a location and the history flags", () => {
    expect(parseAgentMessage(msg({ url: `${PROXY}/a`, title: "A", canBack: true, canForward: false }), "t")).toEqual({
      type: "nav",
      url: `${PROXY}/a`,
      title: "A",
      canBack: true,
      canForward: false,
    });
  });
  it("treats anything but a real true as false, and needs the token", () => {
    expect(parseAgentMessage(msg({ url: "x", canBack: "yes", canForward: 1 }), "t")).toMatchObject({ canBack: false, canForward: false });
    expect(parseAgentMessage(msg({ url: "x" }), "other")).toBeNull();
  });
});

describe("autoSelect follows in-page navigation", () => {
  it("keeps the page the user navigated to on the same server", () => {
    expect(autoSelect({ url: "http://localhost:3000/docs/intro", auto: true }, ["http://localhost:3000/"])).toBeNull();
    expect(autoSelect({ url: "http://localhost:3000/docs/intro", auto: true }, ["http://localhost:4000/"])).toBe("http://localhost:4000/");
  });
  it("tolerates a stored address that does not parse", () => {
    expect(autoSelect({ url: "garbage", auto: true }, ["http://localhost:4000/"])).toBe("http://localhost:4000/");
  });
});
