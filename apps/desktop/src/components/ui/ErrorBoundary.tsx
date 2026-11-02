import { Component, type ErrorInfo, type ReactNode } from "react";
import { errorMessage } from "@/lib/utils";

interface Props {
  /** What to show instead of the children once one of them throws while rendering. */
  fallback: (error: string, reset: () => void) => ReactNode;
  /** The boundary tries its children again when this changes (another agent, an updated item). */
  resetKey?: unknown;
  children: ReactNode;
}

interface State {
  error: string | null;
}

/**
 * Keeps a rendering mistake (one odd timeline item, one broken card) from taking the whole window down
 * with it: React unmounts the entire tree when nothing catches the error.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(e: unknown): State {
    return { error: errorMessage(e) };
  }

  componentDidCatch(e: unknown, info: ErrorInfo) {
    console.error("A component failed to render:", e, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error !== null && !Object.is(prev.resetKey, this.props.resetKey)) this.setState({ error: null });
  }

  reset = () => this.setState({ error: null });

  render() {
    return this.state.error === null ? this.props.children : this.props.fallback(this.state.error, this.reset);
  }
}
