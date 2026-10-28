import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { installNavigationGuard, linkMismatchHost, loopbackLink, openLink, resolveAgentId, splitLoopbackUrls } from "./external";
import { openPreview } from "@/store/preview";
import { useUi } from "@/store/ui";

vi.mock("./api", () => ({ api: { openPath: vi.fn(async () => {}) } }));
vi.mock("@/store/preview", () => ({ openPreview: vi.fn() }));

describe("linkMismatchHost", () => {
  it("flags text that names a different host", () => {
    expect(linkMismatchHost("github.com/foo/bar", "https://evil.example/x")).toBe("evil.example");
    expect(linkMismatchHost("https://github.com", "http://github.com.evil.io/")).toBe("github.com.evil.io");
  });
  it("accepts matching hosts, ignoring www and case", () => {
    expect(linkMismatchHost("https://GitHub.com/a", "https://github.com/b")).toBeNull();
    expect(linkMismatchHost("www.example.com", "https://example.com/")).toBeNull();
  });
  it("ignores ordinary link text", () => {
    expect(linkMismatchHost("the docs", "https://evil.example")).toBeNull();
    expect(linkMismatchHost("click here now.", "https://evil.example")).toBeNull();
    expect(linkMismatchHost("example.com", undefined)).toBeNull();
    expect(linkMismatchHost("example.com", "not a url")).toBeNull();
  });
});

describe("loopback links", () => {
  const plain = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, button: 0 };

  beforeEach(() => {
    useUi.setState({ view: "agents", selectedAgentId: "a1" });
    vi.mocked(openPreview).mockClear();
    vi.mocked(api.openPath).mockClear();
  });

  it("detects loopback http(s) only", () => {
    expect(loopbackLink("http://127.0.0.1:4323")).toBe("http://127.0.0.1:4323/");
    expect(loopbackLink("https://localhost:3000/x")).toBe("https://localhost:3000/x");
    expect(loopbackLink("http://[::1]:80/")).not.toBeNull();
    expect(loopbackLink("https://example.com")).toBeNull();
    expect(loopbackLink("localhost:3000")).toBeNull();
    expect(loopbackLink("mailto:a@b.c")).toBeNull();
  });

  it("opens Preview for the resolved agent", () => {
    expect(openLink("http://127.0.0.1:4323", plain, "a1")).toBe(true);
    expect(openPreview).toHaveBeenCalledWith("a1", "http://127.0.0.1:4323/");
    expect(api.openPath).not.toHaveBeenCalled();
  });

  it("opens the link's agent first when it isn't selected", () => {
    openLink("http://localhost:5173", plain, "a2");
    expect(useUi.getState().selectedAgentId).toBe("a2");
    expect(openPreview).toHaveBeenCalledWith("a2", "http://localhost:5173/");
  });

  it("keeps modifiers, middle click, no agent and external hosts on the OS browser", () => {
    expect(openLink("http://localhost:1", { ...plain, ctrlKey: true }, "a1")).toBe(false);
    expect(openLink("http://localhost:1", { ...plain, metaKey: true }, "a1")).toBe(false);
    expect(openLink("http://localhost:1", { ...plain, shiftKey: true }, "a1")).toBe(false);
    expect(openLink("http://localhost:1", { ...plain, button: 1 }, "a1")).toBe(false);
    expect(openLink("http://localhost:1", plain, null)).toBe(false);
    expect(openLink("https://example.com", plain, "a1")).toBe(false);
    expect(openPreview).not.toHaveBeenCalled();
    expect(api.openPath).toHaveBeenCalledTimes(6);
  });

  const fakeEl = (agent: string | null) =>
    ({ closest: () => (agent ? { getAttribute: () => agent } : null) }) as unknown as Element;

  it("resolves the agent from data-agent-id, else the Agents view selection", () => {
    expect(resolveAgentId(fakeEl("z"))).toBe("z");
    expect(resolveAgentId(fakeEl(null))).toBe("a1");
    useUi.setState({ view: "mission" as never });
    expect(resolveAgentId(fakeEl(null))).toBeNull();
  });

  it("guard routes plain clicks to Preview and Ctrl-clicks to the browser", () => {
    class FakeAnchor {
      constructor(
        private href: string,
        private agent: string | null,
        private ownClick = false,
      ) {}
      getAttribute() {
        return this.href;
      }
      hasAttribute(name: string) {
        return name === "data-own-click" && this.ownClick;
      }
      get textContent() {
        return "server";
      }
      closest(sel: string) {
        return sel === "a[href]" ? this : this.agent ? { getAttribute: () => this.agent } : null;
      }
    }
    const handlers: Record<string, (e: unknown) => void> = {};
    vi.stubGlobal("HTMLAnchorElement", FakeAnchor);
    vi.stubGlobal("document", {
      addEventListener: (t: string, h: (e: unknown) => void) => (handlers[t] = h),
      removeEventListener: () => {},
    });
    vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
    const off = installNavigationGuard();
    const click = (mods: object, ownClick = false) => {
      const target = new FakeAnchor("http://127.0.0.1:4323", "a1", ownClick);
      const e = { type: "click", button: 0, defaultPrevented: false, target, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...mods };
      handlers.click(e);
      return e;
    };
    const e1 = click({});
    expect(openPreview).toHaveBeenCalledTimes(1);
    expect(e1.stopPropagation).toHaveBeenCalled();
    click({ ctrlKey: true });
    expect(openPreview).toHaveBeenCalledTimes(1);
    expect(api.openPath).toHaveBeenCalledTimes(1);
    // Self-handled links (Markdown) are left to their own handler: no second open.
    const e3 = click({}, true);
    expect(e3.preventDefault).toHaveBeenCalled();
    expect(openPreview).toHaveBeenCalledTimes(1);
    expect(api.openPath).toHaveBeenCalledTimes(1);
    off();
    vi.unstubAllGlobals();
  });
});

describe("splitLoopbackUrls", () => {
  it("returns text untouched without loopback hosts", () => {
    expect(splitLoopbackUrls("hello https://example.com")).toEqual(["hello https://example.com"]);
  });
  it("splits out loopback URLs and trims trailing punctuation", () => {
    expect(splitLoopbackUrls("Local: http://localhost:5173/, ready\nNet: http://127.0.0.1:4323")).toEqual([
      "Local: ",
      { url: "http://localhost:5173/" },
      ", ready\nNet: ",
      { url: "http://127.0.0.1:4323" },
    ]);
  });
});
