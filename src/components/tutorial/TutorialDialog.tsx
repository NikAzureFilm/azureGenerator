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
    image: '/tutorial/01-modes.png',
    alt: 'Home screen with the CAD Engineering and Mesh Generation mode cards',
    title: 'Two ways to create',
    description:
      'AzureFilm Generator has two modes. CAD Engineering is for practical models and 3D prints — precise parts and mechanisms. Mesh Generation is for figurines, sculptures, and organic shapes.',
  },
  {
    image: '/tutorial/02-prompt.png',
    alt: 'Prompt box with a spice rack description typed in and the CAD mode selected',
    title: 'Describe what you want',
    description:
      'Type a prompt with the details that matter — like exact widths, slot sizes, or wall thickness. Use the wand to enhance or generate a prompt for you, or attach a reference image.',
  },
  {
    image: '/tutorial/03-generating.png',
    alt: 'Editor showing the generation point cloud while a model is being built',
    title: 'Let the AI build it',
    description:
      'Generation takes about a minute. You can orbit the preview while your model takes shape.',
  },
  {
    image: '/tutorial/04-parameters.png',
    alt: 'Spice rack model with the parameters panel showing dimension sliders',
    title: 'Adjust parameters — completely free',
    description:
      'CAD models come out fully parametric. Drag the sliders to change any dimension — width, slot count, wall thickness — and the model rebuilds instantly. Adjustments cost nothing, so go nuts.',
  },
  {
    image: '/tutorial/05-edit-chat.png',
    alt: 'Chat asking to add a wall on the back, with the updated model as version 2',
    title: 'Ask for bigger changes',
    description:
      'Need something the sliders can’t do? Tell the assistant — "add a wall on the back" — and it builds a new version. You can flip between versions any time.',
  },
  {
    image: '/tutorial/06-export.png',
    alt: 'Export menu listing STL, SCAD, DXF, STEP and OBJ formats',
    title: 'Export for print or CAD',
    description:
      'Download STL for 3D printing, or SCAD, DXF, STEP and OBJ for other tools — all from the export menu under the parameters panel.',
  },
  {
    image: '/tutorial/07-image-input.png',
    alt: 'Create input image dialog with the 3D Object Agent and Premium or Lite quality options',
    title: 'Mesh mode can start from an image',
    description:
      'In Mesh Generation you can generate an input image first: the Object Agent turns your prompt into a clean object reference, so you preview what the 3D model will look like before generating it. Pick Lite or Premium quality.',
  },
  {
    image: '/tutorial/08-multiview.png',
    alt: 'Multiview strip with front reference plus generated left, back and right views of a dragon',
    title: 'Multiview for all-around models',
    description:
      'Want a model that looks good from every angle? Generate left, back and right views from your front reference — regenerate any angle you don’t like (Premium is more likely to give a good output) — then build from all four.',
  },
  {
    image: '/tutorial/09-mesh-export.png',
    alt: 'Finished mushroom figurine with the download menu showing 3MF color print and other formats',
    title: 'Download your mesh — with color',
    description:
      'Mesh models export to STL, OBJ, GLB and more. If you want color in your 3D print, choose 3MF — it keeps the colors.',
  },
  {
    image: '/tutorial/10-gallery.png',
    alt: 'Past Creations gallery with cards for previous generations',
    title: 'Everything stays in Creations',
    description:
      'Every generation is saved — find it in the sidebar or browse the visual gallery. Keep iterating: each edit becomes a new version you can come back to.',
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
        className="max-h-[95vh] w-[97vw] max-w-[1800px] overflow-y-auto border-adam-neutral-800 bg-adam-bg-secondary-dark p-4 text-adam-text-primary sm:rounded-xl sm:p-6"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{slide.title}</DialogTitle>
          <DialogDescription>{slide.description}</DialogDescription>
        </DialogHeader>

        {/* Screenshot — sized by viewport height so it renders as large as
            the screen allows (all sources share the 1920×930 crop, so no
            letterbox). On load failure we swap in a framed title placeholder
            that keeps the same footprint. */}
        <div className="flex w-full items-center justify-center">
          {failedImages[index] ? (
            <div className="flex aspect-[1920/930] max-h-[72vh] w-full items-center justify-center rounded-lg border border-adam-neutral-800 bg-adam-neutral-950 px-6 text-center text-base font-medium text-adam-text-secondary">
              {slide.title}
            </div>
          ) : (
            <img
              src={slide.image}
              alt={slide.alt}
              loading="lazy"
              onError={() =>
                setFailedImages((prev) => ({ ...prev, [index]: true }))
              }
              className="max-h-[72vh] w-auto max-w-full rounded-lg border border-adam-neutral-800 bg-adam-neutral-950 object-contain"
            />
          )}
        </div>

        <div className="mt-5 flex flex-col gap-2">
          <h2 className="text-2xl font-semibold text-adam-text-primary">
            {slide.title}
          </h2>
          <p className="text-lg leading-relaxed text-adam-text-secondary">
            {slide.description}
          </p>
        </div>

        {/* Dot indicators */}
        <div className="mt-4 flex items-center justify-center gap-2">
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
        <div className="mt-4 flex items-center justify-between gap-3">
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
