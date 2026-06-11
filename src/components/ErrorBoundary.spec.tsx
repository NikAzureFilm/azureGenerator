import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ErrorBoundary } from './ErrorBoundary';

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('boom');
  }
  return <div>all good</div>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React logs caught render errors to console.error; keep test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div>content</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('content')).toBeTruthy();
  });

  it('shows a labeled fallback when a child throws', () => {
    render(
      <ErrorBoundary label="3D viewer">
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByText('The 3D viewer ran into a problem')).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('recovers via the reset button once the cause is gone', () => {
    function Harness() {
      const [shouldThrow, setShouldThrow] = useState(true);
      return (
        <div>
          <button onClick={() => setShouldThrow(false)}>fix</button>
          <ErrorBoundary>
            <Bomb shouldThrow={shouldThrow} />
          </ErrorBoundary>
        </div>
      );
    }

    render(<Harness />);
    expect(screen.getByText('Something went wrong')).toBeTruthy();

    fireEvent.click(screen.getByText('fix'));
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByText('all good')).toBeTruthy();
  });
});
