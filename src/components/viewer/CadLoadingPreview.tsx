import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { GlbPreview } from './GlbPreview';
import { useIsMobile } from '@/hooks/useIsMobile';

interface CadLoadingPreviewProps {
  generationId?: string;
  label?: string;
  className?: string;
  markClassName?: string;
}

export function CadLoadingPreview({
  generationId,
  label = 'Generating STEP CAD preview...',
  className,
  markClassName,
}: CadLoadingPreviewProps) {
  const isMobile = useIsMobile();
  const [startTime, setStartTime] = useState(() => Date.now());
  const previousGenerationId = useRef(generationId);

  useEffect(() => {
    if (previousGenerationId.current === generationId) return;
    previousGenerationId.current = generationId;
    setStartTime(Date.now());
  }, [generationId]);

  return (
    <div
      data-testid="cad-loading-preview"
      className={cn(
        'relative flex h-full max-h-dvh w-full flex-col items-center justify-center gap-2 text-adam-text-primary',
        className,
      )}
    >
      <div
        className={cn(
          'w-full',
          isMobile ? 'aspect-square h-fit' : 'h-full',
          markClassName,
        )}
      >
        <GlbPreview startTime={startTime} />
      </div>
      {label ? (
        <div
          className={cn(
            'flex h-8 w-full max-w-2xl items-center justify-center transition-all duration-300 ease-in-out',
            !isMobile && 'absolute top-3/4',
          )}
        >
          <p className="text-xs font-medium text-adam-text-primary/70">
            {label}
          </p>
        </div>
      ) : null}
    </div>
  );
}
