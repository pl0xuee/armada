import { Component, type ErrorInfo, type ReactNode } from "react";
import { Icon } from "./Icon";
import { Button } from "./ui";

interface Props {
  children: ReactNode;
  /** Changing this (e.g. the route) clears a caught error. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

/**
 * Last line of defence: a rendering bug shows a recoverable error screen
 * instead of a blank page.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[armada] render error", error, info.componentStack);
  }

  override componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center px-safe pt-[var(--safe-top)] pb-[var(--safe-bottom)] text-center" role="alert">
        <span className="mb-5 inline-flex h-16 w-16 items-center justify-center rounded-[20px] border border-err/30 bg-err/10 text-err edge">
          <Icon name="alertCircle" size={28} strokeWidth={1.6} />
        </span>
        <h1 className="text-[18px] font-semibold text-fg">Something went wrong</h1>
        <p className="mt-1.5 max-w-[320px] text-[14px] leading-relaxed text-muted">
          This screen hit an unexpected error. Your agents on your computer are not affected.
        </p>
        <p className="mt-3 max-w-[340px] truncate font-mono text-[12px] text-steel">{error.message}</p>
        <div className="mt-6 flex gap-2">
          <Button variant="secondary" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
          <Button variant="primary" icon="refresh" onClick={() => location.reload()}>
            Reload
          </Button>
        </div>
      </main>
    );
  }
}
