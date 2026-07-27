import { describe, expect, it, vi, beforeAll } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  CHAT_PANEL_BOUNDS,
  PREVIEW_PANEL_BOUNDS,
  useChatPanelSizes,
} from './useChatPanelSizes';

// The hook measures its element with a ResizeObserver, which jsdom does not
// ship. The stub records the callback so a test can fire a "resize".
let lastObserverCallback: (() => void) | null = null;
const disconnect = vi.fn();

class ResizeObserverStub {
  constructor(callback: () => void) {
    lastObserverCallback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {
    disconnect();
  }
}

beforeAll(() => {
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
});

function elementOfWidth(width: number) {
  const element = document.createElement('div');
  Object.defineProperty(element, 'offsetWidth', {
    configurable: true,
    get: () => width,
  });
  return element;
}

describe('useChatPanelSizes', () => {
  it('leaves the panel unbounded until the container is measured', () => {
    const { result } = renderHook(() => useChatPanelSizes(CHAT_PANEL_BOUNDS));

    expect(result.current.panelSizes).toEqual({
      defaultSize: 30,
      minSize: 0,
      maxSize: 100,
    });
  });

  it('converts the pixel bounds to percentages of the measured width', () => {
    const { result } = renderHook(() => useChatPanelSizes(CHAT_PANEL_BOUNDS));

    act(() => {
      result.current.setContainerRef(elementOfWidth(1280));
    });

    // 384px and 550px of a 1280px container.
    expect(result.current.panelSizes.minSize).toBeCloseTo(30);
    expect(result.current.panelSizes.maxSize).toBeCloseTo(42.96875);
    expect(result.current.panelSizes.defaultSize).toBeCloseTo(30);
  });

  it('clamps the default up to the min on a narrow container', () => {
    const { result } = renderHook(() => useChatPanelSizes(CHAT_PANEL_BOUNDS));

    act(() => {
      result.current.setContainerRef(elementOfWidth(800));
    });

    // 384/800 = 48% min, so the 30% default has to grow to meet it.
    expect(result.current.panelSizes.minSize).toBeCloseTo(48);
    expect(result.current.panelSizes.defaultSize).toBeCloseTo(48);
  });

  it('never lets the max exceed the whole container', () => {
    const { result } = renderHook(() => useChatPanelSizes(CHAT_PANEL_BOUNDS));

    act(() => {
      result.current.setContainerRef(elementOfWidth(400));
    });

    expect(result.current.panelSizes.maxSize).toBe(100);
  });

  it('re-measures when the container resizes', () => {
    const { result } = renderHook(() => useChatPanelSizes(CHAT_PANEL_BOUNDS));

    let width = 1280;
    const element = document.createElement('div');
    Object.defineProperty(element, 'offsetWidth', {
      configurable: true,
      get: () => width,
    });

    act(() => {
      result.current.setContainerRef(element);
    });
    expect(result.current.panelSizes.minSize).toBeCloseTo(30);

    width = 1920;
    act(() => {
      lastObserverCallback?.();
    });
    expect(result.current.panelSizes.minSize).toBeCloseTo(20);
  });

  it('ignores a null element', () => {
    const { result } = renderHook(() => useChatPanelSizes(CHAT_PANEL_BOUNDS));

    act(() => {
      result.current.setContainerRef(null);
    });

    expect(result.current.panelSizes.minSize).toBe(0);
  });
});

describe('panel bounds', () => {
  it('keeps the creative and agent splits on the same spec', () => {
    expect(CHAT_PANEL_BOUNDS).toEqual({
      defaultSize: 30,
      minWidth: 384,
      maxWidth: 550,
    });
    expect(PREVIEW_PANEL_BOUNDS).toEqual({ defaultSize: 70, minSize: 20 });
  });
});
