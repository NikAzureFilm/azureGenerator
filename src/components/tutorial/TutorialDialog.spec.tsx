import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { TUTORIAL_SLIDES, TutorialDialog } from './TutorialDialog';

function renderOpenDialog(onOpenChange = vi.fn()) {
  render(<TutorialDialog open onOpenChange={onOpenChange} />);
  return onOpenChange;
}

describe('TutorialDialog', () => {
  it('shows the first slide when opened', () => {
    renderOpenDialog();
    expect(
      screen.getAllByText(TUTORIAL_SLIDES[0].title).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(`1 / ${TUTORIAL_SLIDES.length}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: /back/i })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('advances with Next and goes back with Back', () => {
    renderOpenDialog();
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(
      screen.getAllByText(TUTORIAL_SLIDES[1].title).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(`2 / ${TUTORIAL_SLIDES.length}`)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByText(`1 / ${TUTORIAL_SLIDES.length}`)).toBeTruthy();
  });

  it('navigates with arrow keys and clamps at the ends', () => {
    renderOpenDialog();
    const content = screen.getByRole('dialog');

    fireEvent.keyDown(content, { key: 'ArrowLeft' });
    expect(screen.getByText(`1 / ${TUTORIAL_SLIDES.length}`)).toBeTruthy();

    fireEvent.keyDown(content, { key: 'ArrowRight' });
    expect(screen.getByText(`2 / ${TUTORIAL_SLIDES.length}`)).toBeTruthy();
  });

  it('jumps to a slide from the dot indicators', () => {
    renderOpenDialog();
    fireEvent.click(
      screen.getByRole('button', {
        name: `Go to slide ${TUTORIAL_SLIDES.length}`,
      }),
    );
    expect(
      screen.getByText(`${TUTORIAL_SLIDES.length} / ${TUTORIAL_SLIDES.length}`),
    ).toBeTruthy();
  });

  it('closes via Get started on the last slide', () => {
    const onOpenChange = renderOpenDialog();
    fireEvent.click(
      screen.getByRole('button', {
        name: `Go to slide ${TUTORIAL_SLIDES.length}`,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /get started/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('resets to the first slide when reopened', () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(true)}>reopen</button>
          <TutorialDialog open={open} onOpenChange={setOpen} />
        </>
      );
    }
    render(<Harness />);

    fireEvent.click(
      screen.getByRole('button', {
        name: `Go to slide ${TUTORIAL_SLIDES.length}`,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /get started/i }));
    fireEvent.click(screen.getByRole('button', { name: 'reopen' }));

    expect(screen.getByText(`1 / ${TUTORIAL_SLIDES.length}`)).toBeTruthy();
  });

  it('collapses to a title-only placeholder when the image fails to load', () => {
    renderOpenDialog();
    fireEvent.error(screen.getByAltText(TUTORIAL_SLIDES[0].alt));
    expect(screen.queryByAltText(TUTORIAL_SLIDES[0].alt)).toBeNull();
    expect(
      screen.getAllByText(TUTORIAL_SLIDES[0].title).length,
    ).toBeGreaterThan(0);
  });
});
