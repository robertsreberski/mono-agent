import {
  Component,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";

import { renderErrorReport, serializeRenderError, type ConversationRenderContext, type RenderErrorReport } from "./render-error-diagnostics";

export interface RenderErrorFallbackProps {
  readonly error: unknown;
  readonly report?: RenderErrorReport;
  readonly reset: () => void;
}

export type RenderErrorReporter = (report: RenderErrorReport) => void;

export const reportRenderError: RenderErrorReporter = (report) => {
  console.error(`[mono-agent] ${report.scope} render failed`, report);
};

interface RenderErrorBoundaryProps {
  readonly children: ReactNode;
  readonly fallback: (props: RenderErrorFallbackProps) => ReactNode;
  readonly reporter?: RenderErrorReporter;
  readonly getDiagnosticContext?: () => ConversationRenderContext;
  readonly resetKey?: string;
  readonly scope: string;
}

interface RenderErrorBoundaryState {
  readonly failure: { readonly error: unknown; readonly report?: RenderErrorReport } | null;
}

export class RenderErrorBoundary extends Component<
  RenderErrorBoundaryProps,
  RenderErrorBoundaryState
> {
  state: RenderErrorBoundaryState = { failure: null };

  static getDerivedStateFromError(error: unknown): RenderErrorBoundaryState {
    return { failure: { error } };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const report = renderErrorReport(this.props.scope, error, info.componentStack, this.props.getDiagnosticContext);
    this.setState({ failure: { error, report } });
    (this.props.reporter ?? reportRenderError)(report);
  }

  componentDidUpdate(
    previous: RenderErrorBoundaryProps,
    previousState: RenderErrorBoundaryState,
  ): void {
    if (
      this.state.failure !== null &&
      previousState.failure !== null &&
      previous.resetKey !== this.props.resetKey
    ) {
      this.setState({ failure: null });
    }
  }

  private readonly reset = (): void => {
    this.setState({ failure: null });
  };

  render(): ReactNode {
    if (this.state.failure !== null) {
      return this.props.fallback({ ...this.state.failure, reset: this.reset });
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

export function ConversationErrorFallback({ error, report, reset }: RenderErrorFallbackProps) {
  const [copyStatus, setCopyStatus] = useState("");
  const diagnostic = report?.error ?? serializeRenderError(error);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(report ?? { error: diagnostic }, null, 2));
      setCopyStatus("Copied technical details");
    } catch {
      setCopyStatus("Could not copy. Select the details to copy them manually.");
    }
  };
  return (
    <div className="chat-empty thread-render-error" role="alert">
      <span className="eyebrow">Conversation unavailable</span>
      <h2>Something went wrong</h2>
      <p>This conversation could not be displayed. You can switch conversations or try loading it again.</p>
      <button type="button" className="primary-button" onClick={reset}>Reload conversation</button>
      <details className="render-error-details">
        <summary>Technical details</summary>
        <pre>{diagnostic.name}: {diagnostic.message}</pre>
        <button type="button" onClick={() => void copy()}>Copy technical details</button>
        <span role="status">{copyStatus}</span>
      </details>
    </div>
  );
}
