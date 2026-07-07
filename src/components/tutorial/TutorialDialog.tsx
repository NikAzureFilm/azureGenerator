import { useEffect, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface TutorialSlide {
  image: string;
  alt: string;
  title: string;
  description: string;
}

export const TUTORIAL_SLIDES: TutorialSlide[] = [
  {
    image: '/tutorial/01-welcome.png',
    alt: 'AzureFilm Generator home screen with CAD Engineering and Mesh Generation modes',
    title: 'Welcome to AzureFilm Generator',
    description:
      'Generate 3D-printable CAD models from plain text and images. Pick a creation mode: CAD Engineering for precise parametric parts, or Mesh Generation for organic shapes and figurines.',
  },
  {
    image: '/tutorial/02-prompt.png',
    alt: 'Prompt box with reference image and model quality controls',
    title: 'Describe what you want to build',
    description:
      'Type a prompt, attach reference images, and choose the model quality. The wand button can enhance your prompt automatically.',
  },
  {
    image: '/tutorial/03-editor.png',
    alt: 'Editor with an interactive 3D viewer and view gizmo',
    title: 'Review your model in 3D',
    description:
      'Every generation opens in the editor with an interactive 3D viewer. Orbit with the mouse, snap views with the cube gizmo, and tune lighting from the toolbar.',
  },
  {
    image: '/tutorial/04-parameters.png',
    alt: 'Parametric model with dimension sliders in the parameters panel',
    title: 'Tweak parameters live',
    description:
      'CAD Engineering models are fully parametric: adjust dimensions with sliders and the model recompiles instantly. No regeneration tokens needed.',
  },
  {
    image: '/tutorial/05-download.png',
    alt: 'Export menu showing STL, STEP, OBJ, DXF, SCAD and color 3MF formats',
    title: 'Export in any format',
    description:
      'Download STL for printing, or STEP, OBJ, DXF, SCAD and color 3MF for editing elsewhere. The export menu lives at the bottom of the parameters panel.',
  },
  {
    image: '/tutorial/06-history.png',
    alt: 'Sidebar generation history and the Generations gallery',
    title: 'Find everything you made',
    description:
      'The sidebar keeps every generation one click away, and the Generations gallery gives you a visual overview. Rename, share, or delete from the card menu.',
  },
  {
    image: '/tutorial/07-pricing.png',
    alt: 'Pricing page with per-workflow token costs and the sidebar token widget',
    title: 'Tokens power everything',
    description:
      'Each generation costs tokens depending on the workflow and quality. Check the pricing page for exact costs, and top up from the token widget in the sidebar.',
  },
];

interface TutorialDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TutorialDialog({ open, onOpenChange }: TutorialDialogProps) {
  const [index, setIndex] = useState(0);
  // Track per-slide image load failures so a broken screenshot collapses to a
  // title-only placeholder instead of showing the browser's broken-image icon.
  const [failedImages, setFailedImages] = useState<Record<number, boolean>>({});

  const total = TUTORIAL_SLIDES.length;
  const slide = TUTORIAL_SLIDES[index];
  const isFirst = index === 0;
  const isLast = index === total - 1;

  // Reset to the first slide whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setIndex(0);
    }
  }, [open]);

  const goPrev = () => setIndex((i) => Math.max(0, i - 1));
  const goNext = () => setIndex((i) => Math.min(total - 1, i + 1));

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goPrev();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      goNext();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onKeyDown={handleKeyDown}
        className="max-h-[90vh] w-[95vw] max-w-3xl overflow-y-auto border-adam-neutral-800 bg-adam-bg-secondary-dark p-6 text-adam-text-primary sm:rounded-xl sm:p-8"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{slide.title}</DialogTitle>
          <DialogDescription>{slide.description}</DialogDescription>
        </DialogHeader>

        {/* Screenshot — fixed ~16:10 container so mixed source sizes look
            uniform. On load failure we hide the img and keep the framed
            container with the slide title only. */}
        <div className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-lg border border-adam-neutral-800 bg-adam-neutral-950">
          {failedImages[index] ? (
            <span className="px-6 text-center text-sm font-medium text-adam-text-secondary">
              {slide.title}
            </span>
          ) : (
            <img
              src={slide.image}
              alt={slide.alt}
              loading="lazy"
              onError={() =>
                setFailedImages((prev) => ({ ...prev, [index]: true }))
              }
              className="h-full w-full object-contain"
            />
          )}
        </div>

        <div className="mt-5 flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-adam-text-primary">
            {slide.title}
          </h2>
          <p className="text-sm leading-relaxed text-adam-text-secondary">
            {slide.description}
          </p>
        </div>

        {/* Dot indicators */}
        <div className="mt-5 flex items-center justify-center gap-2">
          {TUTORIAL_SLIDES.map((s, i) => (
            <button
              key={s.image}
              type="button"
              aria-label={`Go to slide ${i + 1}`}
              aria-current={i === index ? 'true' : undefined}
              onClick={() => setIndex(i)}
              className={cn(
                'h-2 rounded-full transition-all duration-200',
                i === index
                  ? 'w-5 bg-adam-blue'
                  : 'w-2 bg-adam-neutral-800 hover:bg-adam-neutral-400',
              )}
            />
          ))}
        </div>

        {/* Navigation */}
        <div className="mt-6 flex items-center justify-between gap-3">
          <Button
            variant="outline"
            className="h-9 gap-1.5"
            onClick={goPrev}
            disabled={isFirst}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>

          <span className="text-xs tabular-nums text-adam-neutral-400">
            {index + 1} / {total}
          </span>

          {isLast ? (
            <Button
              className="h-9 gap-1.5 bg-adam-blue text-white hover:bg-adam-blue/90"
              onClick={() => onOpenChange(false)}
            >
              Get started
            </Button>
          ) : (
            <Button
              className="h-9 gap-1.5 bg-adam-blue text-white hover:bg-adam-blue/90"
              onClick={goNext}
            >
              Next
              <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
