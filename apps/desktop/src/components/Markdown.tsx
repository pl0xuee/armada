import { memo, useDeferredValue, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageOff } from "lucide-react";
import { isExternalUrl, openExternal } from "@/lib/external";
import { cn } from "@/lib/utils";
import { CopyButton } from "./CopyButton";

function CodeBlock({ lang, code }: { lang: string | null; code: string }) {
  const isDiff = lang === "diff" || lang === "patch";
  const lines = code.replace(/\n$/, "").split("\n");
  return (
    <div className="group/code my-3 overflow-hidden rounded-xl border border-line bg-code edge">
      <div className="flex h-8 items-center justify-between border-b border-line bg-panel/60 pl-3 pr-1.5">
        <span className="font-mono text-[11px] lowercase tracking-wide text-steel">{lang ?? "text"}</span>
        <CopyButton text={code} className="opacity-70 group-hover/code:opacity-100" />
      </div>
      <pre className="selectable overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-[1.6]">
        <code>
          {isDiff
            ? lines.map((l, i) => (
                <span
                  key={i}
                  className={cn(
                    "-mx-3.5 block px-3.5",
                    l.startsWith("+") && "bg-[var(--diff-add)] text-ok",
                    l.startsWith("-") && "bg-[var(--diff-del)] text-err",
                    l.startsWith("@@") && "text-accent/80",
                  )}
                >
                  {l || " "}
                </span>
              ))
            : code.replace(/\n$/, "")}
        </code>
      </pre>
    </div>
  );
}

function RemoteImageChip({ url, alt }: { url: string; alt: string }) {
  let label = url;
  try {
    const u = new URL(url);
    label = `${u.host}${u.pathname.length > 1 ? u.pathname : ""}`;
  } catch {
    /* keep raw */
  }
  const external = isExternalUrl(url);
  return (
    <button
      type="button"
      disabled={!external}
      title={external ? `Open ${url} in your browser` : "Image not shown"}
      onClick={() => external && void openExternal(url)}
      className="mx-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-line-strong bg-raised px-1.5 py-0.5 align-middle text-[12px] text-muted transition-colors hover:text-fg disabled:opacity-60"
    >
      <ImageOff className="h-3.5 w-3.5 shrink-0 text-steel" />
      <span className="truncate">
        Image{alt ? ` “${alt}”` : ""}: {label || "unavailable"}
      </span>
    </button>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return "";
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const match = /language-([\w+-]+)/.exec(className ?? "");
    const text = textOf(children);
    const block = Boolean(match) || text.includes("\n");
    if (!block) return <code>{children}</code>;
    return <CodeBlock lang={match ? match[1] : null} code={text} />;
  },
  a: ({ href, children }) => (
    <a
      href={href}
      rel="noreferrer noopener"
      title={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) void openExternal(href);
      }}
    >
      {children}
    </a>
  ),
  // Never fetch remote images from agent output: a prompt-injected agent could
  // exfiltrate data through the URL. Show a link chip instead.
  img: ({ src, alt }) => {
    const url = typeof src === "string" ? src : "";
    if (/^data:image\//i.test(url)) return <img src={url} alt={alt ?? ""} className="max-w-full rounded-lg" />;
    return <RemoteImageChip url={url} alt={alt ?? ""} />;
  },
};

export const Markdown = memo(function Markdown({
  text,
  className,
  streaming,
}: {
  text: string;
  className?: string;
  streaming?: boolean;
}) {
  // While streaming, let React skip intermediate parses under load.
  const deferred = useDeferredValue(text);
  return (
    <div className={cn("prose-armada selectable", streaming && "[&>*:last-child]:caret", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {streaming ? deferred : text}
      </ReactMarkdown>
    </div>
  );
});
