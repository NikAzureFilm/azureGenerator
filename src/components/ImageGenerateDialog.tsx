import { ChangeEvent, useRef } from 'react';
import { ImagePlus, Loader2, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  getImageGenerationTokenCost,
  IMAGE_GENERATION_MODELS,
  type ImageGenerationModel,
} from '@shared/imageGeneration';
import { formatTokenCost } from '@shared/tokenCosts';

const VALID_IMAGE_FORMATS = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
];

export interface ImageGenerateReference {
  id: string;
  previewUrl: string;
  label?: string;
  removable?: boolean;
}

interface ImageGenerateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  references: ImageGenerateReference[];
  onAddReferenceFile: (file: File) => Promise<void> | void;
  onRemoveReference: (id: string) => void;
  isUploadingReference?: boolean;
  prompt: string;
  onPromptChange: (next: string) => void;
  promptPlaceholder?: string;
  model: ImageGenerationModel;
  onModelChange: (model: ImageGenerationModel) => void;
  isGenerating: boolean;
  onGenerate: () => void;
  generateLabel?: string;
  maxReferences?: number;
}

export function ImageGenerateDialog({
  open,
  onOpenChange,
  title,
  description,
  references,
  onAddReferenceFile,
  onRemoveReference,
  isUploadingReference = false,
  prompt,
  onPromptChange,
  promptPlaceholder,
  model,
  onModelChange,
  isGenerating,
  onGenerate,
  generateLabel = 'Generate image',
  maxReferences,
}: ImageGenerateDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const busy = isGenerating || isUploadingReference;
  const canAddMore = maxReferences == null || references.length < maxReferences;

  const handleFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await onAddReferenceFile(file);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-w-xl border-adam-neutral-700 bg-adam-neutral-950 text-adam-text-primary"
        onClick={(event) => event.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription className="text-adam-text-secondary">
              {description}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <div className="space-y-3">
          <input
            ref={fileInputRef}
            type="file"
            accept={VALID_IMAGE_FORMATS.join(',')}
            className="hidden"
            onChange={handleFileSelected}
          />
          <div className="flex flex-wrap gap-2">
            {references.map((ref) => {
              const removable = ref.removable !== false;
              return (
                <div key={ref.id} className="relative">
                  <img
                    src={ref.previewUrl}
                    alt={ref.label ?? 'Reference'}
                    className="h-24 w-24 rounded-md border border-adam-neutral-700 object-cover"
                  />
                  {ref.label ? (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 rounded-b-md bg-black/70 px-1 py-0.5 text-center text-[10px] font-medium text-white">
                      {ref.label}
                    </div>
                  ) : null}
                  {removable ? (
                    <button
                      type="button"
                      onClick={() => onRemoveReference(ref.id)}
                      className="absolute -right-2 -top-2 rounded-full bg-adam-neutral-800 p-1 text-adam-text-primary hover:bg-adam-neutral-700"
                      disabled={busy}
                      aria-label="Remove reference image"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  ) : null}
                </div>
              );
            })}
            {canAddMore ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className={cn(
                  'flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-adam-neutral-700 bg-adam-background-2 text-[11px] text-adam-text-secondary hover:border-adam-blue/40 hover:bg-adam-bg-secondary-dark disabled:opacity-50',
                )}
              >
                {isUploadingReference ? (
                  <Loader2 className="h-5 w-5 animate-spin text-adam-blue" />
                ) : (
                  <ImagePlus className="h-5 w-5" />
                )}
                <span>
                  {isUploadingReference ? 'Uploading…' : 'Add reference'}
                </span>
              </button>
            ) : null}
          </div>
          <Textarea
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            placeholder={promptPlaceholder}
            className="min-h-28 resize-none border-adam-neutral-700 bg-adam-background-2 text-adam-text-primary placeholder:text-adam-text-secondary/70"
            disabled={isGenerating}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                onGenerate();
              }
            }}
          />
          <div className="text-xs text-adam-text-secondary">
            Cost: {formatTokenCost(getImageGenerationTokenCost(model))}
          </div>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-adam-neutral-800 p-1">
            {IMAGE_GENERATION_MODELS.map((option) => {
              const selected = model === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={busy}
                  onClick={() => onModelChange(option.id)}
                  className={cn(
                    'rounded-md px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    selected
                      ? 'bg-adam-blue text-white'
                      : 'text-adam-text-secondary hover:bg-adam-neutral-700 hover:text-adam-text-primary',
                  )}
                >
                  <span className="block text-xs font-medium">
                    {option.name}
                  </span>
                  <span
                    className={cn(
                      'mt-0.5 block text-[10px]',
                      selected ? 'text-white/80' : 'text-adam-text-secondary',
                    )}
                  >
                    {formatTokenCost(getImageGenerationTokenCost(option.id))}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            className="border-adam-neutral-700 bg-adam-background-2 text-adam-text-secondary hover:bg-adam-bg-secondary-dark"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            className="bg-adam-blue text-white hover:bg-adam-blue/90"
            onClick={onGenerate}
            disabled={busy}
          >
            {isGenerating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            {generateLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
