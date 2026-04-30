import { Box, Ruler } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  CREATION_MODE_OPTIONS,
  type CreationModeType,
} from '@/utils/creationModeOptions';

type CreationModeCardsProps = {
  selectedType: CreationModeType;
  onTypeChange: (type: CreationModeType) => void;
  className?: string;
};

export function CreationModeCards({
  selectedType,
  onTypeChange,
  className,
}: CreationModeCardsProps) {
  return (
    <div className={cn('grid w-full gap-3 md:grid-cols-2', className)}>
      {CREATION_MODE_OPTIONS.map((option) => {
        const isSelected = option.type === selectedType;
        const Icon = option.type === 'parametric' ? Ruler : Box;

        return (
          <button
            key={option.type}
            type="button"
            aria-pressed={isSelected}
            onClick={() => onTypeChange(option.type)}
            className={cn(
              'group relative flex overflow-hidden rounded-xl border bg-adam-background-2 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-adam-blue focus-visible:ring-offset-2 focus-visible:ring-offset-adam-bg-secondary-dark',
              isSelected
                ? 'border-adam-blue/80 shadow-[0_0_0_1px_rgba(15,95,244,0.32),0_18px_44px_rgba(0,0,0,0.22)]'
                : 'border-white/10 shadow-[0_14px_34px_rgba(0,0,0,0.16)] hover:border-white/20 hover:bg-[#1d1e1e]',
            )}
          >
            <div className="relative z-10 flex w-full flex-col justify-between p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div
                    className={cn(
                      'mb-3 flex h-8 w-8 items-center justify-center rounded-lg border transition-colors',
                      isSelected
                        ? 'border-adam-blue/40 bg-adam-blue/15 text-adam-blue'
                        : 'border-white/10 bg-white/[0.03] text-adam-text-secondary group-hover:text-adam-text-primary',
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                  <h2 className="text-base font-semibold leading-tight text-adam-text-primary">
                    {option.title}
                  </h2>
                  <p className="mt-1 max-w-[18rem] text-sm leading-5 text-adam-text-secondary">
                    {option.description}
                  </p>
                </div>
                <span
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
                    isSelected
                      ? 'border-adam-blue/30 bg-adam-blue/10 text-adam-blue'
                      : 'border-white/10 bg-white/[0.03] text-adam-text-tertiary',
                  )}
                >
                  {isSelected ? 'Selected' : 'Choose'}
                </span>
              </div>

              <CreationModePreview
                alt={`${option.title} preview`}
                src={option.imageSrc}
                selected={isSelected}
              />
            </div>
          </button>
        );
      })}
    </div>
  );
}

function CreationModePreview({
  alt,
  selected,
  src,
}: {
  alt: string;
  selected: boolean;
  src: string;
}) {
  return (
    <div
      className={cn(
        'mt-4 aspect-[3/1] overflow-hidden rounded-lg border bg-[#161717] transition-colors',
        selected ? 'border-adam-blue/40' : 'border-white/10',
      )}
    >
      <img
        src={src}
        alt={alt}
        className="h-full w-full object-contain object-center"
        draggable={false}
      />
    </div>
  );
}
