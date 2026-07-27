import { describe, expect, it, vi, beforeAll } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Panel, PanelGroup } from 'react-resizable-panels';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChatPanelResizeHandle } from './ChatPanelResizeHandle';

// react-resizable-panels measures its group with a ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  globalThis.ResizeObserver =
    globalThis.ResizeObserver ??
    (ResizeObserverStub as unknown as typeof ResizeObserver);
});

function renderHandle(isCollapsed: boolean) {
  const onCollapse = vi.fn();
  const onExpand = vi.fn();
  render(
    <TooltipProvider>
      <PanelGroup direction="horizontal">
        <Panel />
        <ChatPanelResizeHandle
          isCollapsed={isCollapsed}
          onCollapse={onCollapse}
          onExpand={onExpand}
        />
        <Panel />
      </PanelGroup>
    </TooltipProvider>,
  );
  return { onCollapse, onExpand };
}

describe('ChatPanelResizeHandle', () => {
  it('offers the collapse control while the panel is open', () => {
    const { onCollapse } = renderHandle(false);

    expect(
      screen.queryByRole('button', { name: 'Expand chat panel' }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Collapse chat panel' }),
    );
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it('swaps to the Chat tab once collapsed', () => {
    const { onExpand } = renderHandle(true);

    expect(
      screen.queryByRole('button', { name: 'Collapse chat panel' }),
    ).toBeNull();
    expect(screen.getByText('Chat')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Expand chat panel' }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});
