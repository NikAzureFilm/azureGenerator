import { useCallback, useMemo, useRef, useState } from 'react';

// Bounds for the chat/preview split, shared by the creative and agent editors:
// the chat column stays wide enough for a readable line, and never so wide that
// the preview loses the space.
export const CHAT_PANEL_BOUNDS = {
  defaultSize: 30,
  minWidth: 384,
  maxWidth: 550,
} as const;

export const PREVIEW_PANEL_BOUNDS = {
  defaultSize: 70,
  minSize: 20,
} as const;

// Chat panels are specced in pixels (a readable line length) but
// react-resizable-panels sizes in percentages, so the container has to be
// measured before the bounds can be converted. Mirrors the sizing the creative
// editor's split uses.
export function useChatPanelSizes({
  defaultSize,
  minWidth,
  maxWidth,
}: {
  defaultSize: number;
  minWidth: number;
  maxWidth: number;
}) {
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const setContainerRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;

    setContainerWidth(element.offsetWidth);

    resizeObserverRef.current = new ResizeObserver(() => {
      setContainerWidth(element.offsetWidth);
    });
    resizeObserverRef.current.observe(element);

    return () => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    };
  }, []);

  const panelSizes = useMemo(() => {
    // Before the first measurement, leave the panel unbounded so it renders at
    // its default instead of snapping to a bogus min/max.
    if (containerWidth === 0) {
      return { defaultSize, minSize: 0, maxSize: 100 };
    }

    const minSize = (minWidth / containerWidth) * 100;
    const maxSize = Math.min((maxWidth / containerWidth) * 100, 100);

    return {
      defaultSize: Math.min(Math.max(defaultSize, minSize), maxSize),
      minSize,
      maxSize,
    };
  }, [containerWidth, defaultSize, minWidth, maxWidth]);

  return { setContainerRef, panelSizes };
}
