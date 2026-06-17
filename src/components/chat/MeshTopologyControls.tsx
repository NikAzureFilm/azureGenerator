import React, { useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CreativeModel, Model } from '@shared/types';
import {
  getModelDefaultPolygonCount,
  getMaxPolygonCount,
} from '@/constants/meshConstants';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';

// SVG Icon component for the quads/polys toggle
const QuadsPolysSvg = ({ color = '#D7D7D7' }: { color?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
  >
    <path
      d="M8 2V14"
      stroke={color}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M2 8H14"
      stroke={color}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M12.6667 2H3.33333C2.59695 2 2 2.59695 2 3.33333V12.6667C2 13.403 2.59695 14 3.33333 14H12.6667C13.403 14 14 13.403 14 12.6667V3.33333C14 2.59695 13.403 2 12.6667 2Z"
      stroke={color}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// SVG Icon component for the polygon count toggle
const PolygonCountSvg = ({ color = '#D7D7D7' }: { color?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
  >
    <g clipPath="url(#clip0_17634_35890)">
      <path
        d="M1.66651 11.2524C1.58733 11.2062 1.51853 11.1441 1.46442 11.0701C1.41031 10.9961 1.37205 10.9117 1.35203 10.8222C1.33201 10.7328 1.33065 10.6401 1.34806 10.5501C1.36546 10.4601 1.40125 10.3746 1.45317 10.2991L7.45317 1.61908C7.51461 1.53106 7.5964 1.45917 7.69157 1.40954C7.78675 1.3599 7.8925 1.33398 7.99984 1.33398C8.10718 1.33398 8.21294 1.3599 8.30811 1.40954C8.40329 1.45917 8.48507 1.53106 8.54651 1.61908L14.5465 10.2924C14.5996 10.3682 14.6363 10.4542 14.6543 10.5449C14.6723 10.6356 14.6712 10.7291 14.6512 10.8194C14.6311 10.9097 14.5925 10.9948 14.5377 11.0693C14.483 11.1439 14.4133 11.2062 14.3332 11.2524L8.65984 14.4924C8.45874 14.607 8.23128 14.6672 7.99984 14.6672C7.7684 14.6672 7.54094 14.607 7.33984 14.4924L1.66651 11.2524Z"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 1.33398V14.6673"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
    <defs>
      <clipPath id="clip0_17634_35890">
        <rect width="16" height="16" fill="white" />
      </clipPath>
    </defs>
  </svg>
);

// Polygon Input State Machine
type PolygonInputState = { type: 'idle' } | { type: 'editing'; value: string };

// Polygon Button Component
interface PolygonButtonProps {
  polygonCount: number;
  meshTopology: 'quads' | 'polys';
  model: Model;
  showFullLabels: boolean;
  isLoading: boolean;
  disabled: boolean;
  onPolygonCountChange: (count: number) => void;
  onReset: () => void;
}

// Quads Button Component
interface QuadsButtonProps {
  meshTopology: 'quads' | 'polys';
  showFullLabels: boolean;
  isLoading: boolean;
  disabled: boolean;
  onToggle: () => void;
}

export const QuadsButton = ({
  meshTopology,
  showFullLabels,
  isLoading,
  disabled,
  onToggle,
}: QuadsButtonProps) => {
  const isQuadsEnabled = meshTopology === 'quads';

  const buttonContent = (
    <button
      onClick={onToggle}
      disabled={isLoading || disabled}
      aria-pressed={isQuadsEnabled}
      className={cn(
        'flex h-8 items-center gap-2 rounded-full border px-2 text-sm transition-colors duration-200',
        'hover:bg-adam-bg-secondary-dark focus:outline-none focus-visible:outline-none focus-visible:ring-0',
        'items-center justify-center',
        isQuadsEnabled
          ? 'border-transparent bg-adam-blue-dark/15 hover:bg-adam-blue-dark/20'
          : 'border-[#2a2a2a] bg-transparent',
        showFullLabels && 'pr-[8px]',
      )}
    >
      <QuadsPolysSvg color={isQuadsEnabled ? '#0F5FF4' : '#D7D7D7'} />
      {showFullLabels && (
        <span
          className={cn(
            'hidden text-xs text-adam-text-primary lg:inline',
            isQuadsEnabled && 'text-[#0F5FF4]',
          )}
        >
          Quads
        </span>
      )}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{buttonContent}</TooltipTrigger>
      <TooltipContent>
        {isQuadsEnabled ? 'Quad topology enabled' : 'Switch to quad topology'}
      </TooltipContent>
    </Tooltip>
  );
};

export const PolygonButton = ({
  polygonCount,
  meshTopology,
  model,
  showFullLabels,
  isLoading,
  disabled,
  onPolygonCountChange,
  onReset,
}: PolygonButtonProps) => {
  // Computed values - no useState needed
  const maxPolygonCount = getMaxPolygonCount(
    model as CreativeModel,
    meshTopology,
  );
  // Use model-specific default for determining if value is custom
  const defaultPolygonCount = getModelDefaultPolygonCount(
    model as CreativeModel,
    meshTopology,
  );
  const maxInputValue = Math.floor(maxPolygonCount / 1000);
  const isCustom = polygonCount !== defaultPolygonCount;

  // Only state needed - popover open/closed and input editing
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [isSliderDragging, setIsSliderDragging] = useState(false);
  const [closeGuardUntil, setCloseGuardUntil] = useState<number>(0);
  const [inputState, setInputState] = useState<PolygonInputState>({
    type: 'idle',
  });

  const formatPolygonCount = (count: number) => {
    return count >= 1000 ? `${Math.floor(count / 1000)}K` : count.toString();
  };

  const handleSliderChange = (value: number[]) => {
    onPolygonCountChange(value[0]);
  };

  const handleInputStart = (e: React.FocusEvent<HTMLInputElement>) => {
    setInputState({
      type: 'editing',
      value: Math.floor(polygonCount / 1000).toString(),
    });
    // Auto-select all text when focused
    e.target.select();
  };

  const handleInputChange = (value: string) => {
    if (inputState.type === 'editing') {
      if (value === '' || (/^\d+$/.test(value) && parseInt(value, 10) >= 0)) {
        setInputState({ type: 'editing', value });
      }
    }
  };

  const handleInputComplete = () => {
    if (inputState.type === 'editing') {
      const numValue = parseInt(inputState.value, 10);
      if (!isNaN(numValue) && numValue >= 1 && numValue <= maxInputValue) {
        onPolygonCountChange(numValue * 1000);
      }
      setInputState({ type: 'idle' });
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleInputComplete();
      setIsPopoverOpen(false); // Close the popover
    }
  };

  const buttonContent = (
    <button
      onClick={() => setIsPopoverOpen(true)}
      disabled={isLoading || disabled}
      className={cn(
        'flex h-8 items-center gap-[6px] rounded-full border px-2 text-sm transition-colors duration-200',
        'hover:bg-adam-bg-secondary-dark focus:outline-none focus-visible:outline-none focus-visible:ring-0',
        'items-center justify-center',
        // When popover is open and value is at model-specific default or input is empty while editing,
        // highlight with neutral-800 background
        isPopoverOpen &&
          (!isCustom ||
            (inputState.type === 'editing' && inputState.value === ''))
          ? 'border-transparent bg-adam-neutral-800 hover:bg-adam-neutral-700'
          : isCustom
            ? 'border-transparent bg-adam-blue-dark/15 hover:bg-adam-blue-dark/20'
            : 'border-[#2a2a2a] bg-transparent',
        isCustom && 'pr-[10px]',
      )}
    >
      <PolygonCountSvg color={isCustom ? '#0F5FF4' : '#D7D7D7'} />
      {showFullLabels && (
        <span
          className={cn(
            'hidden text-xs lg:inline',
            isCustom ? 'text-[#0F5FF4]' : 'text-adam-text-primary',
          )}
        >
          {isCustom ? formatPolygonCount(polygonCount) : 'Polygons'}
        </span>
      )}
      {isCustom && (
        <span
          className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center"
          title={`Reset to default (${formatPolygonCount(defaultPolygonCount)})`}
        >
          <X
            className="h-3.5 w-3.5 cursor-pointer text-[#0F5FF4] transition-opacity hover:opacity-70"
            onClick={(e) => {
              e.stopPropagation();
              onReset();
            }}
          />
        </span>
      )}
    </button>
  );

  const popoverContent = (
    <PopoverContent
      align="start"
      className="flex w-56 flex-col items-start gap-3 self-stretch rounded-full border-0 bg-adam-neutral-700 p-2 shadow-none"
      onOpenAutoFocus={(e) => e.preventDefault()}
      onInteractOutside={(e) => {
        // Keep popover open if user is dragging or within post-drag guard window
        if (isSliderDragging || Date.now() < closeGuardUntil) {
          e.preventDefault();
        }
      }}
    >
      <div className="flex w-full flex-col gap-3">
        <div
          className="flex h-6 items-center gap-3"
          data-polygon-popover-interactive
        >
          <Slider
            value={[Math.max(1000, polygonCount)]}
            defaultValue={[defaultPolygonCount]}
            onValueChange={handleSliderChange}
            onValueCommit={handleSliderChange}
            max={maxPolygonCount}
            min={1000}
            step={1000}
            hideDefaultMarker
            variant="capsule"
            className="flex-1"
            onPointerDown={() => setIsSliderDragging(true)}
            onPointerUp={() => {
              setIsSliderDragging(false);
              setCloseGuardUntil(Date.now() + 150);
            }}
          />
          <div className="flex items-center gap-1 pr-2">
            <Input
              type="text"
              value={
                inputState.type === 'editing'
                  ? inputState.value
                  : Math.floor(polygonCount / 1000).toString()
              }
              onChange={(e) => handleInputChange(e.target.value)}
              onFocus={(e) => handleInputStart(e)}
              onBlur={handleInputComplete}
              onKeyDown={handleInputKeyDown}
              onClick={(e) => {
                e.stopPropagation();
                // Also select all text when clicking on the input
                (e.target as HTMLInputElement).select();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="h-6 w-12 rounded-md border border-adam-neutral-700 bg-adam-neutral-800 px-1 py-0 text-center text-xs text-adam-text-primary selection:bg-[#70B8FF7A] selection:text-white focus:ring-1 focus:ring-adam-blue/20"
            />
            <span className="text-xs">k</span>
          </div>
        </div>
      </div>
    </PopoverContent>
  );

  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            <Popover open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
              <PopoverTrigger asChild>{buttonContent}</PopoverTrigger>
              {popoverContent}
            </Popover>
          </div>
        </TooltipTrigger>
        <TooltipContent>Adjust polygon count</TooltipContent>
      </Tooltip>
    </div>
  );
};
