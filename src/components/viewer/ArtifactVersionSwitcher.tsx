import { ParametricArtifact } from '@shared/types';
import { cn } from '@/lib/utils';

// Compact label for a version pill: prefer the artifact's own version string
// ('v2' -> 'V2'); fall back to the 1-based position for unlabeled artifacts.
export function versionLabel(
  artifact: ParametricArtifact | undefined,
  index: number,
): string {
  const raw = artifact?.version?.trim();
  return raw ? raw.toUpperCase() : `V${index + 1}`;
}

interface ArtifactVersionSwitcherProps {
  versions: ParametricArtifact[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}

// Floating segmented control over the preview letting the user view each
// pre-revision model the inspection loop produced. Renders nothing with a
// single version, so old messages and one-shot generations look unchanged.
export function ArtifactVersionSwitcher({
  versions,
  selectedIndex,
  onSelect,
}: ArtifactVersionSwitcherProps) {
  if (versions.length <= 1) return null;
  const latestIndex = versions.length - 1;

  return (
    <div
      role="group"
      aria-label="Model version"
      className="absolute left-4 top-4 z-10 flex items-center gap-0.5 rounded-lg border border-adam-neutral-800/40 bg-adam-background-2/95 p-1 shadow-lg backdrop-blur-sm"
    >
      {versions.map((artifact, index) => {
        const selected = index === selectedIndex;
        const isLatest = index === latestIndex;
        return (
          <button
            key={index}
            type="button"
            aria-pressed={selected}
            title={isLatest ? 'Latest version' : `Version ${index + 1}`}
            onClick={() => onSelect(index)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition-colors',
              selected
                ? 'bg-adam-neutral-50 text-adam-neutral-900'
                : 'text-adam-text-primary/70 [@media(hover:hover)]:hover:bg-adam-neutral-800 [@media(hover:hover)]:hover:text-adam-text-primary',
            )}
          >
            {versionLabel(artifact, index)}
            {isLatest && (
              <span
                aria-hidden
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  selected ? 'bg-adam-blue' : 'bg-adam-blue/70',
                )}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
