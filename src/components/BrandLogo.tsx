import { cn } from '@/lib/utils';
import { brandAsset, BRAND_NAME } from '@/config/brand';

type BrandLogoProps = {
  variant?: 'wordmark' | 'mark';
  className?: string;
  imgClassName?: string;
};

export function BrandLogo({
  variant = 'wordmark',
  className,
  imgClassName,
}: BrandLogoProps) {
  const src = brandAsset(
    variant === 'mark' ? 'azurefilm-mark.png' : 'azurefilm-logo.png',
  );

  if (variant === 'mark') {
    return (
      <span
        className={cn(
          'inline-flex aspect-square shrink-0 items-center justify-center',
          className,
        )}
      >
        <img
          src={src}
          alt={BRAND_NAME}
          className={cn('block h-full w-full object-contain', imgClassName)}
        />
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-2 overflow-visible',
        className,
      )}
    >
      <img
        src={src}
        alt={BRAND_NAME}
        className={cn(
          'block h-full min-w-0 flex-1 object-contain',
          imgClassName,
        )}
      />
      <span className="shrink-0 text-[0.56em] font-semibold uppercase leading-none tracking-[0.08em] text-adam-neutral-10">
        Generator
      </span>
    </span>
  );
}
