import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { GlbPreview } from './GlbPreview';

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
        'flex h-full w-full flex-col items-center justify-center gap-3 p-4 text-adam-text-primary',
        className,
      )}
    >
      <div className={cn('min-h-0 w-full flex-1', markClassName)}>
        <GlbPreview startTime={startTime} />
      </div>
      {label ? (
        <p className="text-xs font-medium text-adam-text-primary/70">{label}</p>
      ) : null}
    </div>
  );
}
