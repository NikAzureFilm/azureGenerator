/**
 * Slicer-style layer scrubber for the flexi preview.
 *
 * A vertical slider that sets the print height the model is shown up to, the
 * way a slicer's layer slider reveals a sliced part from the bed upward. The
 * value is a FRACTION of the model's print height (1 = whole model), so the
 * scene can turn it into a clipping-plane constant without knowing the mm
 * height; the label converts it to mm and a nominal 0.2mm layer number for the
 * user. It never touches the geometry — the cut is a GPU clip in the scene.
 */
import * as SliderPrimitive from '@radix-ui/react-slider';
import { Layers } from 'lucide-react';

import { cn } from '@/lib/utils';
import { layerReadout } from './flexiToyUi';

export type FlexiLayerSliderProps = {
  /** 0..1 — how much of the model's print height is shown. */
  fraction: number;
  /** Print height of the model in mm (floor-aligned result, so max Y). */
  heightMm: number;
  onFractionChange: (fraction: number) => void;
  className?: string;
};

export function FlexiLayerSlider({
  fraction,
  heightMm,
  onFractionChange,
  className,
}: FlexiLayerSliderProps) {
  const { shownMm, layer, layers } = layerReadout(fraction, heightMm);
  const isFull = fraction >= 1;

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-1.5 rounded-md bg-adam-neutral-950/70 px-1.5 py-2 backdrop-blur',
        className,
      )}
    >
      <Layers
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          isFull ? 'text-adam-text-secondary' : 'text-adam-blue',
        )}
        aria-hidden
      />
      <SliderPrimitive.Root
        orientation="vertical"
        aria-label="Layer view"
        className="relative flex h-full min-h-[6rem] w-6 touch-none select-none flex-col items-center"
        value={[fraction]}
        min={0}
        max={1}
        step={0.005}
        onValueChange={([value]) => onFractionChange(value)}
        onDoubleClick={() => onFractionChange(1)}
      >
        <SliderPrimitive.Track className="relative h-full w-2 grow cursor-pointer overflow-hidden rounded-full bg-sky-500/20">
          <SliderPrimitive.Range className="absolute w-full rounded-full bg-sky-300/40" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          aria-label="Layer view"
          className="block h-4 w-4 cursor-grab rounded-full border-2 border-adam-blue bg-adam-neutral-950 shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-adam-blue/60 active:cursor-grabbing"
        />
      </SliderPrimitive.Root>
      <div
        className="w-full text-center text-[10px] leading-tight text-adam-text-secondary"
        aria-live="polite"
      >
        <div className="tabular-nums text-adam-text-primary">
          {shownMm.toFixed(1)}
          <span className="text-adam-text-secondary"> mm</span>
        </div>
        <div className="tabular-nums">
          {layer}/{layers}
        </div>
      </div>
    </div>
  );
}
