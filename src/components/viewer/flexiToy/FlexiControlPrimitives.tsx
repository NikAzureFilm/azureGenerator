/** Small presentational controls shared across the Flexi Toy dialog. */
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export function PillButton({
  active,
  onClick,
  children,
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        // Comfortable to tap on a phone, compact from sm up. The explicit blue
        // focus ring replaces Chrome's OS-accent outline, which is orange on
        // some systems and would clash with the amber "fused joint" colour.
        'inline-flex min-h-[40px] items-center justify-center rounded-md border px-3 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-adam-blue focus-visible:ring-offset-1 focus-visible:ring-offset-adam-neutral-950 sm:min-h-0 sm:px-2.5 sm:py-1 sm:text-xs',
        active
          ? 'border-adam-blue bg-adam-blue/10 text-adam-blue'
          : 'border-adam-neutral-700 text-adam-text-secondary [@media(hover:hover)]:hover:border-adam-neutral-500',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function StyleCard({
  selected,
  title,
  description,
  onSelect,
}: {
  selected: boolean;
  title: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex min-h-[64px] flex-col gap-1 rounded-lg border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-adam-blue focus-visible:ring-offset-1 focus-visible:ring-offset-adam-neutral-950',
        selected
          ? 'border-adam-blue bg-adam-blue/10 ring-1 ring-adam-blue'
          : 'border-adam-neutral-700 [@media(hover:hover)]:hover:border-adam-neutral-500',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
            selected
              ? 'border-adam-blue bg-adam-blue'
              : 'border-adam-neutral-500',
          )}
        >
          {selected ? (
            <span className="h-1.5 w-1.5 rounded-full bg-white" />
          ) : null}
        </span>
        <span className="text-sm font-medium">{title}</span>
      </div>
      <p className="text-xs leading-snug text-adam-text-secondary">
        {description}
      </p>
    </button>
  );
}

export function ControlLabel({
  label,
  value,
}: {
  label: string;
  value?: ReactNode;
}) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-2">
      <label className="text-sm font-medium">{label}</label>
      {value !== undefined ? (
        <span className="text-xs text-adam-text-secondary">{value}</span>
      ) : null}
    </div>
  );
}
