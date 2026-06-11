import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { GenerationErrorNotice } from './GenerationErrorNotice';

describe('GenerationErrorNotice', () => {
  it('shows friendly copy for known error codes without raw detail', () => {
    render(<GenerationErrorNotice error="rate_limited" />);
    expect(screen.getByText(/too quickly/)).toBeTruthy();
    expect(screen.queryByText('Technical details')).toBeNull();
  });

  it('shows technical details for informative raw errors', () => {
    const raw = 'build123d exited with 1: NameError: Box is not defined';
    render(<GenerationErrorNotice error={raw} />);
    expect(screen.getByText('Technical details')).toBeTruthy();
    expect(screen.getByText(raw)).toBeTruthy();
  });

  it('renders a retry button that fires onRetry', () => {
    const onRetry = vi.fn();
    render(
      <GenerationErrorNotice error="timeout after 120s" onRetry={onRetry} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('omits the retry button when no handler is given', () => {
    render(<GenerationErrorNotice error="timeout after 120s" />);
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('disables retry while loading', () => {
    const onRetry = vi.fn();
    render(
      <GenerationErrorNotice
        error="timeout after 120s"
        onRetry={onRetry}
        disabled
      />,
    );
    const button = screen.getByRole('button', {
      name: /try again/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
