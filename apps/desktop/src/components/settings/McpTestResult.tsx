import { CircleCheck, CircleX, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import type { McpServer } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useMcpTestResult, useMcpTests } from "./mcpTest";

/** "Test" button for a server config; `testKey` scopes the cached result (server id or a draft key). */
export function McpTestButton({
  testKey,
  server,
  label = "Test",
  disabled,
  className,
}: {
  testKey: string;
  server: McpServer;
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const result = useMcpTestResult(testKey, server);
  const running = result?.state === "running";
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      disabled={disabled || running}
      onClick={() => void useMcpTests.getState().run(testKey, server)}
      aria-label={`${label}: ${server.name || "server"}`}
      className={className}
    >
      {running ? <Spinner className="h-3.5 w-3.5" /> : <Plug className="!h-3.5 !w-3.5" />}
      {running ? "Testing…" : label}
    </Button>
  );
}

/** Inline result: green line on success, red box with the error output on failure. */
export function McpTestOutcome({
  testKey,
  server,
  className,
}: {
  testKey: string;
  server: McpServer;
  className?: string;
}) {
  const result = useMcpTestResult(testKey, server);
  if (!result || result.state === "running") return null;
  if (result.state === "ok") {
    return (
      <p role="status" className={cn("flex items-center gap-1.5 text-[12px] text-ok", className)}>
        <CircleCheck className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">Connected · {result.message}</span>
      </p>
    );
  }
  return (
    <div role="alert" className={cn("rounded-lg border border-err/30 bg-err/[0.07] px-2.5 py-2", className)}>
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-err">
        <CircleX className="h-3.5 w-3.5 shrink-0" /> Couldn't connect
      </p>
      <pre className="selectable mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-muted">
        {result.message}
      </pre>
    </div>
  );
}
