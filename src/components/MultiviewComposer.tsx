import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useRef,
  useState,
} from 'react';
import { ImagePlus, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MultiviewSlot, MultiviewImages } from '@shared/types';
import { FEATURE_COSTS, formatTokenCost } from '@shared/tokenCosts';
import { supabase } from '@/lib/supabase';
import { useToast } from '@/hooks/use-toast';
import { getMultiviewGenerationReference } from '@/utils/multiviewReference';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

const SLOT_ORDER: MultiviewSlot[] = ['front', 'left', 'back', 'right'];

const SLOT_LABEL: Record<MultiviewSlot, string> = {
  front: 'Front',
  left: 'Left',
  back: 'Back',
  right: 'Right',
};

const VALID_IMAGE_FORMATS = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
];

export interface MultiviewSlotState {
  id?: string; // storage image id once uploaded/generated
  url?: string; // preview URL for display
  isBusy?: boolean; // currently uploading or generating
  kind?: 'upload' | 'generated';
}

export type MultiviewSlotMap = Partial<
  Record<MultiviewSlot, MultiviewSlotState>
>;

interface MultiviewComposerProps {
  conversationId: string;
  userId: string;
  slots: MultiviewSlotMap;
  onSlotsChange: Dispatch<SetStateAction<MultiviewSlotMap>>;
  prompt: string;
  disabled?: boolean;
}

export function MultiviewComposer({
  conversationId,
  userId,
  slots,
  onSlotsChange,
  prompt,
  disabled = false,
}: MultiviewComposerProps) {
  const { toast } = useToast();
  // Pick the first populated slot (in SLOT_ORDER) as the reference image for
  // consistency when generating subsequent views.
  const firstFilledSlot = SLOT_ORDER.find((s) => {
    const state = slots[s];
    return !!state?.id && !state.isBusy;
  });
  const refImageId = getMultiviewGenerationReference({ slots });

  const updateSlot = useCallback(
    (slot: MultiviewSlot, next: MultiviewSlotState | undefined) => {
      onSlotsChange((currentSlots) => {
        const copy: MultiviewSlotMap = { ...currentSlots };
        if (next === undefined) {
          delete copy[slot];
        } else {
          copy[slot] = next;
        }
        return copy;
      });
    },
    [onSlotsChange],
  );

  const handleUpload = useCallback(
    async (slot: MultiviewSlot, file: File) => {
      if (!VALID_IMAGE_FORMATS.includes(file.type)) {
        toast({
          title: 'Invalid image format',
          description: 'Use jpeg, png, or webp.',
        });
        return;
      }
      const id = crypto.randomUUID();
      const objectUrl = URL.createObjectURL(file);
      updateSlot(slot, { id, url: objectUrl, isBusy: true, kind: 'upload' });
      try {
        const { error } = await supabase.storage
          .from('images')
          .upload(`${userId}/${conversationId}/${id}`, file);
        if (error) throw error;
        updateSlot(slot, {
          id,
          url: objectUrl,
          isBusy: false,
          kind: 'upload',
        });
      } catch (error) {
        console.error('Error uploading multiview image:', error);
        URL.revokeObjectURL(objectUrl);
        updateSlot(slot, undefined);
        toast({
          title: 'Upload failed',
          description: 'Could not upload the image. Please try again.',
          variant: 'destructive',
        });
      }
    },
    [conversationId, userId, updateSlot, toast],
  );

  const handleGenerate = useCallback(
    async (slot: MultiviewSlot) => {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt && !refImageId) {
        toast({
          title: 'Need a prompt or a reference',
          description:
            'Type a description, add an input reference, or fill a view first.',
        });
        return;
      }

      updateSlot(slot, { isBusy: true, kind: 'generated' });
      try {
        const { data, error } = await supabase.functions.invoke(
          'generate-view',
          {
            method: 'POST',
            body: {
              conversationId,
              view: slot,
              prompt: trimmedPrompt || undefined,
              refImageId: refImageId || undefined,
              provider: slot === 'front' ? 'openai' : 'nano-banana',
              mode: 'multiview',
            },
          },
        );
        if (error) throw error;
        if (!data?.id || !data?.url) {
          throw new Error('No image returned from generator');
        }
        updateSlot(slot, {
          id: data.id as string,
          url: data.url as string,
          isBusy: false,
          kind: 'generated',
        });
      } catch (error) {
        console.error('Error generating view:', error);
        updateSlot(slot, undefined);
        toast({
          title: 'Generation failed',
          description:
            error instanceof Error
              ? error.message
              : 'Could not generate view. Try again.',
          variant: 'destructive',
        });
      }
    },
    [conversationId, prompt, refImageId, updateSlot, toast],
  );

  const handleRemove = useCallback(
    async (slot: MultiviewSlot) => {
      const current = slots[slot];
      if (!current?.id) return;
      // Best-effort storage cleanup; ignore errors.
      try {
        await supabase.storage
          .from('images')
          .remove([`${userId}/${conversationId}/${current.id}`]);
      } catch (err) {
        console.warn('Failed to remove multiview image from storage:', err);
      }
      if (current.url?.startsWith('blob:')) {
        URL.revokeObjectURL(current.url);
      }
      updateSlot(slot, undefined);
    },
    [slots, conversationId, userId, updateSlot],
  );

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-adam-text-secondary">
          Multiview · 4 angles
        </span>
        <span className="text-[10px] text-adam-text-secondary/70">
          {firstFilledSlot
            ? `${SLOT_LABEL[firstFilledSlot]} is the reference for the other views`
            : 'Add Front first — it becomes the reference for the others'}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {SLOT_ORDER.map((slot) => (
          <MultiviewSlotCard
            key={slot}
            slot={slot}
            state={slots[slot]}
            disabled={disabled}
            onUpload={handleUpload}
            onGenerate={handleGenerate}
            onRemove={handleRemove}
            isReference={slot === firstFilledSlot}
            tokenCost={
              slot === 'front'
                ? FEATURE_COSTS.multiviewFrontImage.tokens
                : FEATURE_COSTS.multiviewNanoBananaView.tokens
            }
          />
        ))}
      </div>
    </div>
  );
}

interface MultiviewSlotCardProps {
  slot: MultiviewSlot;
  state?: MultiviewSlotState;
  disabled: boolean;
  onUpload: (slot: MultiviewSlot, file: File) => void;
  onGenerate: (slot: MultiviewSlot) => void;
  onRemove: (slot: MultiviewSlot) => void;
  isReference?: boolean;
  tokenCost: number;
}

function MultiviewSlotCard({
  slot,
  state,
  disabled,
  onUpload,
  onGenerate,
  onRemove,
  isReference = false,
  tokenCost,
}: MultiviewSlotCardProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isHover, setIsHover] = useState(false);

  const hasImage = !!state?.url && !state?.isBusy;
  const isBusy = !!state?.isBusy;

  const openFilePicker = () => {
    if (disabled || isBusy) return;
    inputRef.current?.click();
  };

  return (
    <div
      className={cn(
        'group relative flex aspect-square w-full flex-col overflow-hidden rounded-lg border-2 transition-colors',
        hasImage
          ? isReference
            ? 'border-adam-blue/60 bg-adam-neutral-900'
            : 'border-adam-neutral-700 bg-adam-neutral-900'
          : 'border-dashed border-adam-neutral-700 bg-adam-background-2 hover:border-adam-neutral-500',
      )}
      onMouseEnter={() => setIsHover(true)}
      onMouseLeave={() => setIsHover(false)}
    >
      {isReference && hasImage && (
        <div className="pointer-events-none absolute left-1 top-1 z-10 rounded bg-adam-blue/90 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-white">
          Reference
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={VALID_IMAGE_FORMATS.join(',')}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUpload(slot, file);
          e.target.value = '';
        }}
      />

      {/* Preview */}
      {hasImage && (
        <img
          src={state!.url}
          alt={`${SLOT_LABEL[slot]} view`}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}

      {/* Busy overlay */}
      {isBusy && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <Loader2 className="h-5 w-5 animate-spin text-white" />
        </div>
      )}

      {/* Empty state actions */}
      {!hasImage && !isBusy && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2">
          <span className="text-[11px] font-medium text-adam-text-secondary">
            {SLOT_LABEL[slot]}
          </span>
          <div className="flex gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={openFilePicker}
                  disabled={disabled}
                  className="flex h-6 w-6 items-center justify-center rounded-md border border-adam-neutral-700 bg-adam-neutral-800 text-adam-text-secondary hover:text-white disabled:opacity-50"
                >
                  <ImagePlus className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Upload</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onGenerate(slot)}
                  disabled={disabled}
                  className="flex h-6 w-6 items-center justify-center rounded-md border border-adam-neutral-700 bg-adam-neutral-800 text-adam-text-secondary hover:text-adam-blue disabled:opacity-50"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Generate with AI</TooltipContent>
            </Tooltip>
          </div>
          <span className="mt-1 rounded bg-adam-neutral-900 px-1.5 py-0.5 text-[9px] text-adam-text-secondary">
            {formatTokenCost(tokenCost)}
          </span>
        </div>
      )}

      {/* Filled-state overlay controls */}
      {hasImage && (
        <>
          <div
            className={cn(
              'pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 py-1 text-[10px] font-medium text-white',
              isHover ? 'opacity-100' : 'opacity-80',
            )}
          >
            {SLOT_LABEL[slot]}
            {state?.kind === 'generated' && (
              <span className="ml-1 text-adam-blue">· AI</span>
            )}
          </div>
          <div
            className={cn(
              'absolute right-1 top-1 flex gap-1 transition-opacity',
              isHover ? 'opacity-100' : 'opacity-0',
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onGenerate(slot)}
                  disabled={disabled}
                  className="flex h-6 w-6 items-center justify-center rounded-full border border-adam-neutral-500 bg-adam-neutral-800/90 text-white hover:bg-adam-neutral-700"
                >
                  <RefreshCw className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Regenerate</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onRemove(slot)}
                  disabled={disabled}
                  className="flex h-6 w-6 items-center justify-center rounded-full border border-adam-neutral-500 bg-adam-neutral-800/90 text-white hover:bg-adam-neutral-700"
                >
                  <X className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Remove</TooltipContent>
            </Tooltip>
          </div>
        </>
      )}
    </div>
  );
}

export function slotsToMultiviewImages(
  slots: MultiviewSlotMap,
): MultiviewImages {
  const out: MultiviewImages = {};
  for (const slot of SLOT_ORDER) {
    const s = slots[slot];
    if (s?.id && !s.isBusy) out[slot] = s.id;
  }
  return out;
}

export function hasAnyMultiviewSlot(slots: MultiviewSlotMap): boolean {
  return SLOT_ORDER.some((s) => !!slots[s]?.id);
}

export function hasFrontMultiviewSlot(slots: MultiviewSlotMap): boolean {
  return !!slots.front?.id && !slots.front?.isBusy;
}

export function anyMultiviewBusy(slots: MultiviewSlotMap): boolean {
  return SLOT_ORDER.some((s) => !!slots[s]?.isBusy);
}
