import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from "react";

export interface RenderErrorFallbackProps {
  readonly error: Error;
  readonly reset: () => void;
}

export type RenderErrorReporter = (
  scope: string,
  error: Error,
  info: ErrorInfo,
) => void;

export const reportRenderError: RenderErrorReporter = (scope, error, info) => {
  console.error(`[mono-agent] ${scope} render failed`, error, {
    componentStack: info.componentStack,
  });
};

interface RenderErrorBoundaryProps {
  readonly children: ReactNode;
  readonly fallback: (props: RenderErrorFallbackProps) => ReactNode;
  readonly reporter?: RenderErrorReporter;
  readonly resetKey?: string;
  readonly scope: string;
}

interface RenderErrorBoundaryState {
  readonly error: Error | null;
}

export class RenderErrorBoundary extends Component<
  RenderErrorBoundaryProps,
  RenderErrorBoundaryState
> {
  state: RenderErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RenderErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    (this.props.reporter ?? reportRenderError)(this.props.scope, error, info);
  }

  componentDidUpdate(previous: RenderErrorBoundaryProps): void {
    if (
      this.state.error !== null &&
      previous.resetKey !== this.props.resetKey
    ) {
      this.setState({ error: null });
    }
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error !== null) {
      return this.props.fallback({ error: this.state.error, reset: this.reset });
    }
    return this.props.children;
  }
}

export function RootErrorFallback({
  reload = () => window.location.reload(),
}: {
  readonly reload?: () => void;
}) {
  return (
    <main className="fatal-state" role="alert">
      <span className="eyebrow">Console unavailable</span>
      <h1>Something went wrong.</h1>
      <p>The mono-agent console could not be displayed.</p>
      <button type="button" className="primary-button" onClick={reload}>
        Reload console
      </button>
    </main>
  );
}
