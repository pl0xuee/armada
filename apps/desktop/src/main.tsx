import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/globals.css";
import { App } from "./App";
import { Button } from "./components/ui/button";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Last resort: without it, one rendering mistake anywhere leaves a blank window. Agents keep running. */}
    <ErrorBoundary
      fallback={(error) => (
        <div
          role="alert"
          className="flex h-screen flex-col items-center justify-center gap-2 bg-base p-8 text-center text-fg"
        >
          <p className="text-[15px] font-semibold">Kvistcode hit a problem drawing this window</p>
          <p className="max-w-lg break-words font-mono text-caption text-muted">{error}</p>
          <p className="text-small text-steel">Your agents keep running. Reloading brings the window back.</p>
          <Button variant="secondary" className="mt-2" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
