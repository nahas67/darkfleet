/**
 * Error boundary.
 *
 * The retired UI had none, so a contract violation threw into React and blanked
 * the entire application with no explanation. This catches a render failure and
 * states what happened, which is the difference between a legible failure and an
 * empty screen an operator cannot diagnose.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null; componentStack: string | null };

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logged, not swallowed. The operator sees the message and the operator's
    // console keeps the stack.
    console.error('DarkFleet render failure', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid h-full w-full place-items-center bg-void p-6" role="alert">
        <div className="df-clipped df-panel max-w-lg p-5">
          <p className="df-label mb-2" style={{ color: 'var(--df-red)' }}>
            Application error
          </p>
          <p className="df-num mb-2 text-[11px] text-ink">{error.message}</p>
          <p className="text-[11px] leading-relaxed text-ink-2">
            The interface could not render this state. Any analysis already completed is
            persisted and remains readable through the API — nothing was lost.
          </p>
          <button
            type="button"
            className="df-btn mt-3"
            onClick={() => this.setState({ error: null, componentStack: null })}
          >
            Retry render
          </button>
        </div>
      </div>
    );
  }
}