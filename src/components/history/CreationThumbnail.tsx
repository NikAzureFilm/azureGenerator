import { useEffect, useRef, useState } from 'react';
import { Box, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCreationThumbnail } from '@/hooks/useCreationThumbnail';

interface CreationThumbnailProps {
  conversationId: string;
  userId: string;
  title?: string;
  /** Sizing/shape of the thumbnail container (e.g. "h-12 w-12"). */
  className?: string;
  /** Sizing of the placeholder/loading icon (e.g. "h-4 w-4"). */
  iconClassName?: string;
}

/**
 * A small static preview image for a creation, used in the history list view
 * and the sidebar. Generation is deferred until the thumbnail scrolls into
 * view and the rendered image is cached per conversation.
 */
export function CreationThumbnail({
  conversationId,
  userId,
  title,
  className,
  iconClassName,
}: CreationThumbnailProps) {
  const [isVisible, setIsVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  const { thumbnail, isLoading } = useCreationThumbnail({
    conversationId,
    userId,
    enabled: isVisible,
  });

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-adam-neutral-700 bg-adam-neutral-950',
        className,
      )}
    >
      {thumbnail ? (
        <img
          src={thumbnail}
          alt={title ? `Preview of ${title}` : 'Generation preview'}
          className="h-full w-full object-cover"
        />
      ) : isVisible && isLoading ? (
        <Loader2
          className={cn(
            'h-4 w-4 animate-spin text-adam-neutral-500',
            iconClassName,
          )}
        />
      ) : (
        <Box className={cn('text-adam-neutral-600 h-4 w-4', iconClassName)} />
      )}
    </div>
  );
}
