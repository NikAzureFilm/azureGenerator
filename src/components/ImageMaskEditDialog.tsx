import { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, Brush, Loader2, Sparkles, Undo2, X } from 'lucide-react';
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
import { Slider } from '@/components/ui/slider';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabase';
import { useConversation } from '@/contexts/ConversationContext';
import { useImageData } from '@/hooks/useImageData';
import { invokeGenerateViewWithFallback } from '@/utils/generateViewWithFallback';
import { buildMaskAlphaData } from '@/utils/maskImage';
import {
  DEFAULT_IMAGE_GENERATION_MODEL,
  getImageGenerationTokenCost,
  IMAGE_GENERATION_MODELS,
  normalizeImageGenerationModel,
  type ImageGenerationModel,
} from '@shared/imageGeneration';
import { formatTokenCost } from '@shared/tokenCosts';

// Mirrors the backend ViewLabel union (supabase/functions/_shared/viewPrompt.ts);
// kept local so the frontend does not import edge-function code.
type ViewLabel = 'front' | 'left' | 'back' | 'right';

const BRUSH_MIN = 8;
const BRUSH_MAX = 120;
const HISTORY_CAP = 20;
// Strokes are painted fully opaque so the exported mask has crisp alpha; the
// translucent look is applied via CSS opacity on the canvas element.
const STROKE_COLOR = 'rgb(255, 0, 0)';
// Display + Gemini-composite opacity for the painted overlay (translucent red).
const OVERLAY_OPACITY = 0.55;
const VALID_VIEWS: ViewLabel[] = ['front', 'left', 'back', 'right'];

// The generate-view function returns a 402 with { error: { code:
// 'insufficient_tokens' } } when the balance is too low. supabase-js surfaces
// this as a FunctionsHttpError whose `context` is the raw Response, so we read
// the body to detect the code (falling back to a generic error otherwise).
async function isInsufficientTokensError(error: unknown): Promise<boolean> {
  if (!error || typeof error !== 'object') return false;
  const direct = (error as { code?: string }).code;
  if (direct === 'insufficient_tokens') return true;
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) {
    try {
      const body = await context.clone().json();
      return body?.error?.code === 'insufficient_tokens';
    } catch {
      return false;
    }
  }
  return false;
}

interface ImageMaskEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageId: string;
  imageUrl: string;
  onEdited: (image: { id: string; url: string }) => void;
}

export function ImageMaskEditDialog({
  open,
  onOpenChange,
  imageId,
  imageUrl,
  onEdited,
}: ImageMaskEditDialogProps) {
  const { toast } = useToast();
  const { conversation } = useConversation();
  const {
    data: { data: imageData },
  } = useImageData(imageId);

  // The generate-view row stores a richer prompt than the shared Prompt type
  // exposes; read the extra edit-relevant fields defensively.
  const sourcePrompt = imageData?.prompt as
    | { view?: string; imageGenerationModel?: ImageGenerationModel }
    | undefined;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageElRef = useRef<HTMLImageElement>(null);
  const naturalSizeRef = useRef<{ width: number; height: number } | null>(null);
  const historyRef = useRef<ImageData[]>([]);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  const [instruction, setInstruction] = useState('');
  const [brushSize, setBrushSize] = useState(48);
  const [isEraser, setIsEraser] = useState(false);
  const [model, setModel] = useState<ImageGenerationModel>(
    DEFAULT_IMAGE_GENERATION_MODEL,
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [hasStrokes, setHasStrokes] = useState(false);
  const [canvasReady, setCanvasReady] = useState(false);

  // Reset all transient editor state whenever the dialog opens for an image.
  useEffect(() => {
    if (!open) return;
    setInstruction('');
    setBrushSize(48);
    setIsEraser(false);
    setHasStrokes(false);
    setCanvasReady(false);
    historyRef.current = [];
    naturalSizeRef.current = null;
    drawingRef.current = false;
    lastPointRef.current = null;
    const fallback = normalizeImageGenerationModel(
      sourcePrompt?.imageGenerationModel ??
        conversation.settings?.imageGenerationModel ??
        DEFAULT_IMAGE_GENERATION_MODEL,
    );
    setModel(fallback);
    // sourcePrompt is intentionally read once on open; it should not re-trigger
    // resets while the user paints.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, imageId]);

  const getContext = () => canvasRef.current?.getContext('2d') ?? null;

  const pushHistory = useCallback(() => {
    const ctx = getContext();
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    const snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    historyRef.current.push(snapshot);
    if (historyRef.current.length > HISTORY_CAP) {
      historyRef.current.shift();
    }
  }, []);

  // Size the stroke canvas to the image's natural resolution once it loads.
  const handleImageLoad = useCallback(() => {
    const img = imageElRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    naturalSizeRef.current = { width, height };
    canvas.width = width;
    canvas.height = height;
    const ctx = getContext();
    if (ctx) {
      ctx.clearRect(0, 0, width, height);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }
    historyRef.current = [];
    setHasStrokes(false);
    setCanvasReady(true);
  }, []);

  // Convert a pointer event to natural-resolution canvas coordinates.
  const toCanvasPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  };

  const paintTo = (point: { x: number; y: number }) => {
    const ctx = getContext();
    if (!ctx) return;
    ctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
    ctx.strokeStyle = STROKE_COLOR;
    ctx.fillStyle = STROKE_COLOR;
    ctx.lineWidth = brushSize;
    const from = lastPointRef.current;
    if (from) {
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
    // Round dot so single taps and stroke ends read as filled circles.
    ctx.beginPath();
    ctx.arc(point.x, point.y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    lastPointRef.current = point;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (isGenerating || !canvasReady) return;
    event.preventDefault();
    canvasRef.current?.setPointerCapture(event.pointerId);
    // Snapshot before the stroke so Undo removes this whole stroke.
    pushHistory();
    drawingRef.current = true;
    lastPointRef.current = null;
    paintTo(toCanvasPoint(event));
    if (!isEraser) setHasStrokes(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    event.preventDefault();
    paintTo(toCanvasPoint(event));
  };

  const endStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    lastPointRef.current = null;
    try {
      canvasRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // pointer may already be released; ignore.
    }
    recomputeHasStrokes();
  };

  // After erasing (or undo) the canvas may be empty; recheck by scanning alpha.
  const recomputeHasStrokes = () => {
    const ctx = getContext();
    const canvas = canvasRef.current;
    if (!ctx || !canvas) {
      setHasStrokes(false);
      return;
    }
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) {
        setHasStrokes(true);
        return;
      }
    }
    setHasStrokes(false);
  };

  const handleUndo = () => {
    const ctx = getContext();
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    const prev = historyRef.current.pop();
    if (prev) {
      ctx.putImageData(prev, 0, 0);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    recomputeHasStrokes();
  };

  const handleClear = () => {
    const ctx = getContext();
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    pushHistory();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasStrokes(false);
  };

  // Build the OpenAI alpha mask: opaque black where preserved, fully
  // transparent (alpha 0) where painted. Strokes are opaque, so a binarized
  // alpha transform gives crisp transparent regions OpenAI will regenerate.
  const buildMaskBlob = async (): Promise<Blob> => {
    const size = naturalSizeRef.current;
    const strokeCanvas = canvasRef.current;
    const strokeCtx = strokeCanvas?.getContext('2d');
    if (!size || !strokeCanvas || !strokeCtx)
      throw new Error('Canvas not ready');
    const strokeImage = strokeCtx.getImageData(0, 0, size.width, size.height);
    const maskData = buildMaskAlphaData(strokeImage.data);
    const out = document.createElement('canvas');
    out.width = size.width;
    out.height = size.height;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    // Copy into a context-owned ImageData (correctly-typed backing buffer)
    // rather than `new ImageData(maskData, ...)`, which the DOM lib rejects for
    // a Uint8ClampedArray whose buffer type is ArrayBufferLike.
    const maskImage = ctx.createImageData(size.width, size.height);
    maskImage.data.set(maskData);
    ctx.putImageData(maskImage, 0, 0);
    return await canvasToPng(out);
  };

  // Build the Gemini composite: original image with painted regions shown as a
  // clearly visible translucent red overlay. Strokes are opaque red, so we drop
  // the overlay opacity at composite time to get the translucent red look.
  const buildMarkedBlob = async (): Promise<Blob> => {
    const size = naturalSizeRef.current;
    const strokeCanvas = canvasRef.current;
    const img = imageElRef.current;
    if (!size || !strokeCanvas || !img) throw new Error('Canvas not ready');
    const out = document.createElement('canvas');
    out.width = size.width;
    out.height = size.height;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(img, 0, 0, out.width, out.height);
    ctx.globalAlpha = OVERLAY_OPACITY;
    ctx.drawImage(strokeCanvas, 0, 0);
    ctx.globalAlpha = 1;
    return await canvasToPng(out);
  };

  const canvasToPng = (canvas: HTMLCanvasElement): Promise<Blob> =>
    new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to encode PNG'));
      }, 'image/png');
    });

  const storagePath = (id: string) =>
    `${conversation.user_id}/${conversation.id}/${id}`;

  const uploadPng = async (
    blob: Blob,
  ): Promise<{ id: string; path: string }> => {
    const id = crypto.randomUUID();
    const path = storagePath(id);
    const { error } = await supabase.storage.from('images').upload(path, blob, {
      contentType: 'image/png',
    });
    if (error) throw error;
    return { id, path };
  };

  const canGenerate =
    hasStrokes && instruction.trim().length > 0 && !isGenerating && canvasReady;

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setIsGenerating(true);
    // Track uploaded artifact paths so we can reclaim them if the edit never
    // produces an image (they are only referenced by the generated row on
    // success; on failure they would otherwise be orphaned in storage).
    let uploadedPaths: string[] = [];
    try {
      const [maskBlob, markedBlob] = await Promise.all([
        buildMaskBlob(),
        buildMarkedBlob(),
      ]);
      const [mask, marked] = await Promise.all([
        uploadPng(maskBlob),
        uploadPng(markedBlob),
      ]);
      uploadedPaths = [mask.path, marked.path];

      const rawView = sourcePrompt?.view;
      const view: ViewLabel = VALID_VIEWS.includes(rawView as ViewLabel)
        ? (rawView as ViewLabel)
        : 'front';

      const { data, error } = await invokeGenerateViewWithFallback(
        (body) =>
          supabase.functions.invoke('generate-view', {
            method: 'POST',
            body,
          }),
        {
          conversationId: conversation.id,
          view,
          prompt: instruction.trim(),
          mode: 'edit',
          refImageIds: [imageId],
          maskImageId: mask.id,
          markedImageId: marked.id,
        },
        model,
      );

      if (error) throw error;
      if (!data?.id || !data?.url) {
        throw new Error('No image returned from generator');
      }

      onEdited({ id: data.id, url: data.url });
      onOpenChange(false);
    } catch (error) {
      // Best-effort cleanup of the orphaned mask/marked artifacts after every
      // fallback has failed; ignore removal errors (RLS/transient).
      if (uploadedPaths.length > 0) {
        try {
          await supabase.storage.from('images').remove(uploadedPaths);
        } catch {
          // best-effort; nothing else to do.
        }
      }
      if (await isInsufficientTokensError(error)) {
        toast({
          title: 'Not enough tokens',
          description:
            'You do not have enough tokens to run this edit. Top up and try again.',
          variant: 'destructive',
        });
      } else {
        console.error('Error generating brush edit:', error);
        toast({
          title: 'Edit failed',
          description:
            error instanceof Error
              ? error.message
              : 'Could not generate the edited image. Try again.',
          variant: 'destructive',
        });
      }
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (isGenerating && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-w-xl border-adam-neutral-700 bg-adam-neutral-950 text-adam-text-primary"
        onClick={(event) => event.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>Edit with brush</DialogTitle>
          <DialogDescription className="text-adam-text-secondary">
            Paint over the regions to change, describe the edit, then regenerate
            only the marked areas.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center justify-center overflow-hidden rounded-md border border-adam-neutral-700 bg-adam-background-2">
            <div className="relative inline-block">
              <img
                ref={imageElRef}
                src={imageUrl}
                alt="Source"
                onLoad={handleImageLoad}
                className="block max-h-[60vh] w-auto max-w-full select-none"
                draggable={false}
              />
              <canvas
                ref={canvasRef}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={endStroke}
                onPointerLeave={endStroke}
                onPointerCancel={endStroke}
                style={{ opacity: OVERLAY_OPACITY }}
                className={cn(
                  'absolute inset-0 h-full w-full touch-none',
                  isGenerating ? 'cursor-not-allowed' : 'cursor-crosshair',
                )}
              />
              {!canvasReady && (
                <div className="absolute inset-0 flex items-center justify-center bg-adam-neutral-900/40">
                  <Loader2 className="h-6 w-6 animate-spin text-adam-text-primary" />
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg bg-adam-neutral-800 p-1">
              <button
                type="button"
                disabled={isGenerating}
                onClick={() => setIsEraser(false)}
                className={cn(
                  'flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-50',
                  !isEraser
                    ? 'bg-adam-blue text-white'
                    : 'text-adam-text-secondary hover:bg-adam-neutral-700 hover:text-adam-text-primary',
                )}
              >
                <Brush className="h-3.5 w-3.5" />
                Brush
              </button>
              <button
                type="button"
                disabled={isGenerating}
                onClick={() => setIsEraser(true)}
                className={cn(
                  'flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-50',
                  isEraser
                    ? 'bg-adam-blue text-white'
                    : 'text-adam-text-secondary hover:bg-adam-neutral-700 hover:text-adam-text-primary',
                )}
              >
                <Eraser className="h-3.5 w-3.5" />
                Eraser
              </button>
            </div>
            <div className="flex min-w-[8rem] flex-1 items-center gap-2">
              <span className="text-xs text-adam-text-secondary">Size</span>
              <Slider
                value={[brushSize]}
                min={BRUSH_MIN}
                max={BRUSH_MAX}
                step={1}
                hideDefaultMarker
                onValueChange={(next) => setBrushSize(next[0] ?? brushSize)}
                className="flex-1"
              />
              <span className="w-8 text-right text-xs text-adam-text-secondary">
                {brushSize}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={isGenerating || !canvasReady}
                onClick={handleUndo}
                className="flex items-center gap-1 rounded-md border border-adam-neutral-700 bg-adam-background-2 px-2 py-1 text-xs text-adam-text-secondary transition-colors hover:bg-adam-bg-secondary-dark disabled:opacity-50"
              >
                <Undo2 className="h-3.5 w-3.5" />
                Undo
              </button>
              <button
                type="button"
                disabled={isGenerating || !canvasReady || !hasStrokes}
                onClick={handleClear}
                className="flex items-center gap-1 rounded-md border border-adam-neutral-700 bg-adam-background-2 px-2 py-1 text-xs text-adam-text-secondary transition-colors hover:bg-adam-bg-secondary-dark disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </button>
            </div>
          </div>

          <Textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="Describe what to change in the marked area…"
            className="min-h-20 resize-none border-adam-neutral-700 bg-adam-background-2 text-adam-text-primary placeholder:text-adam-text-secondary/70"
            disabled={isGenerating}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                handleGenerate();
              }
            }}
          />
          <div className="text-xs text-adam-text-secondary">
            Cost: {formatTokenCost(getImageGenerationTokenCost(model))}
          </div>
          <div className="grid grid-cols-1 gap-1 rounded-lg bg-adam-neutral-800 p-1 sm:grid-cols-3">
            {IMAGE_GENERATION_MODELS.map((option) => {
              const selected = model === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={isGenerating}
                  onClick={() => setModel(option.id)}
                  className={cn(
                    'min-h-[5.5rem] rounded-md px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
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
                      'mt-1 block text-[10px] leading-4',
                      selected ? 'text-white/80' : 'text-adam-text-secondary',
                    )}
                  >
                    {option.description}
                  </span>
                  <span
                    className={cn(
                      'mt-1 block text-[10px]',
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
            disabled={isGenerating}
          >
            Cancel
          </Button>
          <Button
            className="bg-adam-blue text-white hover:bg-adam-blue/90"
            onClick={handleGenerate}
            disabled={!canGenerate}
          >
            {isGenerating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            Generate edit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
