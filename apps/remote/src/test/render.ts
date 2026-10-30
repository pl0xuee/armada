/**
 * Renders a Preact/React element tree to an HTML-like string without a DOM, for component tests.
 * Function components are called directly, so a test must stub the hooks they use
 * (`vi.mock("react", ...)`) and any child component it doesn't care about.
 */
import type { ReactNode } from "react";

interface VNode {
  type: unknown;
  props: Record<string, unknown>;
}

const VOID = new Set(["br", "hr", "img", "input"]);
const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderToString(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string") return escapeText(node);
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderToString).join("");
  const v = node as VNode;
  if (typeof v.type === "function") return renderToString((v.type as (p: unknown) => ReactNode)(v.props));
  if (typeof v.type !== "string") return renderToString(v.props?.children); // fragments
  // `class` first (Preact adds both `class` and `className`), other attributes in source order.
  const cls = (v.props.class ?? v.props.className) as string | undefined;
  const attrs = Object.entries({ ...(cls ? { class: cls } : {}), ...v.props } as Record<string, unknown>)
    .filter(([k, val]) => k !== "children" && k !== "key" && k !== "className" && val !== undefined && val !== false && val !== null)
    .map(([k, val]) => {
      if (k === "style" && typeof val === "object") return ` style="${Object.entries(val as object).map(([a, b]) => `${a}:${b}`).join(";")}"`;
      if (typeof val === "function") return "";
      return val === true ? ` ${k}` : ` ${k}="${String(val).replace(/"/g, "&quot;")}"`;
    })
    .join("");
  if (VOID.has(v.type)) return `<${v.type}${attrs}>`;
  return `<${v.type}${attrs}>${renderToString(v.props.children)}</${v.type}>`;
}
