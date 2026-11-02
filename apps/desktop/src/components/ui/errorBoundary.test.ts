import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function make(resetKey: unknown = 1) {
  const fallback = vi.fn((error: string) => `failed: ${error}`);
  const b = new ErrorBoundary({ fallback, resetKey, children: "content" });
  return { b, fallback };
}

describe("ErrorBoundary", () => {
  it("turns a render error into a readable message, never raw JSON", () => {
    expect(ErrorBoundary.getDerivedStateFromError(new Error("boom"))).toEqual({ error: "boom" });
    expect(ErrorBoundary.getDerivedStateFromError({ message: "bad item" })).toEqual({ error: "bad item" });
  });

  it("shows its children until one throws, then the fallback", () => {
    const { b, fallback } = make();
    expect(b.render()).toBe("content");
    b.state = { error: "boom" };
    expect(b.render()).toBe("failed: boom");
    expect(fallback).toHaveBeenCalledWith("boom", b.reset);
  });

  it("tries again when its reset key changes (another agent, an updated item), not otherwise", () => {
    const { b } = make(1);
    const setState = vi.fn();
    b.setState = setState;
    b.state = { error: "boom" };
    b.componentDidUpdate({ fallback: () => null, resetKey: 1, children: createElement("i") });
    expect(setState).not.toHaveBeenCalled();
    b.componentDidUpdate({ fallback: () => null, resetKey: 0, children: createElement("i") });
    expect(setState).toHaveBeenCalledWith({ error: null });
  });
});
