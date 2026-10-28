import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ api: { probePorts: vi.fn(async (p: number[]) => p) } }));

import { autoSelect, closePreview, openPreview, previewOf, rankLive, togglePreview, usePreview } from "./preview";
import { useUi } from "./ui";

const u = (p: number) => `http://127.0.0.1:${p}/`;

beforeEach(() => {
  usePreview.setState({ byAgent: {} });
  useUi.setState({ view: "agents", selectedAgentId: "a1" });
});

describe("openPreview", () => {
  it("opens the pane and treats a given URL as the user's choice", () => {
    openPreview("a1", "http://localhost:3000/x");
    const st = previewOf(usePreview.getState(), "a1");
    expect(st).toMatchObject({ open: true, url: "http://localhost:3000/x", auto: false });
  });
  it("without a URL keeps the current one", () => {
    openPreview("a1", "http://localhost:3000/");
    closePreview("a1");
    openPreview("a1");
    expect(previewOf(usePreview.getState(), "a1")).toMatchObject({ open: true, url: "http://localhost:3000/" });
  });
  it("selects the agent when another view is showing", () => {
    useUi.setState({ view: "settings", selectedAgentId: null });
    openPreview("a1");
    expect(useUi.getState()).toMatchObject({ view: "agents", selectedAgentId: "a1" });
  });
  it("close resets maximize; toggle flips", () => {
    openPreview("a1");
    usePreview.setState((s) => ({ byAgent: { a1: { ...s.byAgent.a1, maximized: true } } }));
    closePreview("a1");
    expect(previewOf(usePreview.getState(), "a1")).toMatchObject({ open: false, maximized: false });
    togglePreview("a1");
    expect(previewOf(usePreview.getState(), "a1").open).toBe(true);
  });
});

describe("rankLive", () => {
  const ranked = [
    { url: u(4323), port: 4323 },
    { url: u(4321), port: 4321 },
  ];
  it("orders by recency of mention and drops servers that are down", () => {
    expect(rankLive(ranked, new Set([4321, 4323]), [])).toEqual([u(4323), u(4321)]);
    expect(rankLive(ranked, new Set([4323]), [u(4321)])).toEqual([u(4323)]);
  });
  it("keeps older live servers that are no longer mentioned, before the ranked ones", () => {
    expect(rankLive(ranked.slice(0, 1), new Set([4323, 9000]), [u(9000)])).toEqual([u(9000), u(4323)]);
  });
});

describe("autoSelect", () => {
  const live = [u(4321), u(4323)];
  it("follows the newest while the URL was auto-picked or empty", () => {
    expect(autoSelect({ url: "", auto: false }, live)).toBe(u(4323));
    expect(autoSelect({ url: u(4321), auto: true }, live)).toBe(u(4323));
  });
  it("never replaces a URL the user chose", () => {
    expect(autoSelect({ url: u(4321), auto: false }, live)).toBeNull();
  });
  it("does nothing when already on the newest or nothing is live", () => {
    expect(autoSelect({ url: u(4323), auto: true }, live)).toBeNull();
    expect(autoSelect({ url: "", auto: true }, [])).toBeNull();
  });
});
