import {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  KeyboardEvent,
  useCallback,
  useRef,
  useState,
} from 'react';
import { ArrowUp, CircleX, ImagePlus, Loader2, Square } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Content } from '@shared/types';
import { supabase } from '@/lib/supabase';
import { getLevel, useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { VALID_IMAGE_FORMATS } from '@/utils/chatAttachments';
import {
  formatUploadSize,
  getUploadSizeLimitBytes,
} from '@/utils/uploadLimits';
import {
  AGENT_MAX_REFERENCE_IMAGES,
  AGENT_MIN_IMAGE_DIMENSION,
  buildAgentMessageContent,
  selectAgentImageFiles,
} from '@/utils/agentAttachments';

interface AgentAttachment {
  id: string;
  url: string;
  isUploading: boolean;
}

interface AgentComposerProps {
  onSubmit: (content: Content) => void;
  // Storage target for reference images: `${user_id}/${id}/<imageId>` in the
  // images bucket, the same layout the other composers upload to.
  conversation: { id: string; user_id: string };
  isLoading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  stopGenerating?: () => void;
  onFocus?: () => void;
}

// Composer for design-agent conversations: text plus optional reference
// images. No model pickers — the agent drives concept-image generation itself.
export function AgentComposer({
  onSubmit,
  conversation,
  isLoading = false,
  disabled = false,
  placeholder = 'Describe what you want to build...',
  stopGenerating,
  onFocus,
}: AgentComposerProps) {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const [isDragHover, setIsDragHover] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { toast } = useToast();
  const { billing } = useAuth();

  const isUploading = attachments.some((attachment) => attachment.isUploading);
  const canSubmit =
    !disabled &&
    !isLoading &&
    !isUploading &&
    (input.trim().length > 0 || attachments.length > 0);
  const canAttachMore = attachments.length < AGENT_MAX_REFERENCE_IMAGES;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const content = buildAgentMessageContent({
      text: input,
      imageIds: attachments.map((attachment) => attachment.id),
    });
    if (!content) return;
    onSubmit(content);
    setInput('');
    // The sent message renders its images from storage, so the local previews
    // can go.
    attachments.forEach((attachment) => URL.revokeObjectURL(attachment.url));
    setAttachments([]);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  const { mutateAsync: uploadImageAsync } = useMutation({
    mutationFn: async ({ file, id }: { file: File; id: string }) => {
      const { error } = await supabase.storage
        .from('images')
        .upload(`${conversation.user_id}/${conversation.id}/${id}`, file);

      if (error) throw error;
    },
  });

  const addFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;

      if (!conversation.user_id) {
        // Signed-out prompt view: bounce to sign-in instead of failing an
        // upload against a path the user has no access to.
        onFocus?.();
        return;
      }

      const maxUploadBytes = getUploadSizeLimitBytes(getLevel(billing));
      const { accepted, rejections } = selectAgentImageFiles({
        files,
        currentCount: attachments.length,
        maxUploadBytes,
        validFormats: VALID_IMAGE_FORMATS,
      });

      if (rejections.includes('limit')) {
        toast({
          title: 'Reference image limit reached',
          description: `You can attach up to ${AGENT_MAX_REFERENCE_IMAGES} images per message.`,
        });
      } else if (rejections.includes('size')) {
        toast({
          title: 'File too large',
          description: `Images must be smaller than ${formatUploadSize(maxUploadBytes)} on your plan.`,
        });
      } else if (rejections.includes('format')) {
        toast({
          title: 'Invalid image format',
          description: 'Reference images must be JPG, PNG, or WebP.',
        });
      }

      for (const file of accepted) {
        const isLargeEnough = await new Promise<boolean>((resolve) => {
          const image = new Image();
          image.src = URL.createObjectURL(file);
          image.onload = () => {
            const ok =
              image.naturalWidth >= AGENT_MIN_IMAGE_DIMENSION &&
              image.naturalHeight >= AGENT_MIN_IMAGE_DIMENSION;
            URL.revokeObjectURL(image.src);
            resolve(ok);
          };
          image.onerror = () => {
            URL.revokeObjectURL(image.src);
            resolve(false);
          };
        });

        if (!isLargeEnough) {
          toast({
            title: 'Image too small',
            description: `Reference images must be at least ${AGENT_MIN_IMAGE_DIMENSION}x${AGENT_MIN_IMAGE_DIMENSION} pixels.`,
          });
          continue;
        }

        const id = crypto.randomUUID();
        const previewUrl = URL.createObjectURL(file);
        setAttachments((current) => [
          ...current,
          { id, url: previewUrl, isUploading: true },
        ]);

        try {
          await uploadImageAsync({ file, id });
          setAttachments((current) =>
            current.map((attachment) =>
              attachment.id === id
                ? { ...attachment, isUploading: false }
                : attachment,
            ),
          );
        } catch (error) {
          console.error('Error uploading agent reference image:', error);
          URL.revokeObjectURL(previewUrl);
          setAttachments((current) =>
            current.filter((attachment) => attachment.id !== id),
          );
          toast({
            title: 'Error',
            description: 'Failed to upload image',
            variant: 'destructive',
          });
        }
      }
    },
    [
      attachments.length,
      billing,
      conversation.user_id,
      onFocus,
      toast,
      uploadImageAsync,
    ],
  );

  const removeAttachment = async (attachment: AgentAttachment) => {
    if (attachment.isUploading) return;
    URL.revokeObjectURL(attachment.url);
    setAttachments((current) =>
      current.filter((item) => item.id !== attachment.id),
    );
    try {
      await supabase.storage
        .from('images')
        .remove([
          `${conversation.user_id}/${conversation.id}/${attachment.id}`,
        ]);
    } catch (error) {
      console.error('Error removing agent reference image:', error);
    }
  };

  const openFilePicker = () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.multiple = AGENT_MAX_REFERENCE_IMAGES > 1;
    picker.accept = VALID_IMAGE_FORMATS.join(', ');
    picker.onchange = (event) => {
      const files = (event as unknown as ChangeEvent<HTMLInputElement>).target
        .files;
      if (files && files.length > 0) void addFiles(files);
    };
    picker.click();
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = event.clipboardData?.files;
    if (files && files.length > 0) {
      event.preventDefault();
      void addFiles(files);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragHover(false);
    if (disabled) return;
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      void addFiles(files);
    }
  };

  return (
    <div
      onDrop={handleDrop}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setIsDragHover(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setIsDragHover(false);
        }
      }}
      className={cn(
        'flex w-full flex-col gap-2 rounded-xl border border-adam-neutral-700 bg-adam-neutral-800 p-2 transition-colors',
        isDragHover && 'border-adam-blue bg-adam-blue/10',
      )}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 px-1 pt-1">
          <AnimatePresence>
            {attachments.map((attachment) => (
              <motion.div
                key={attachment.id}
                className="relative h-12 w-12 flex-shrink-0"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                layout
              >
                <img
                  src={attachment.url}
                  alt="Reference"
                  className="h-12 w-12 rounded-md object-cover"
                />
                {attachment.isUploading ? (
                  <div className="absolute inset-0 flex items-center justify-center rounded-md bg-black/50">
                    <Loader2 className="h-4 w-4 animate-spin text-white" />
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-label="Remove reference image"
                    onClick={() => void removeAttachment(attachment)}
                    className="absolute right-[-0.5rem] top-[-0.5rem] rounded-full border border-adam-neutral-500 bg-adam-neutral-500 text-white transition-colors duration-200 hover:border-adam-neutral-700 hover:bg-adam-neutral-700"
                  >
                    <CircleX className="h-4 w-4 stroke-[1.5]" />
                  </button>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
      <div className="flex w-full items-end gap-2">
        <Textarea
          ref={textareaRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onFocus={onFocus}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="max-h-40 min-h-[2.5rem] flex-1 resize-none border-none bg-transparent text-sm text-adam-text-primary shadow-none focus-visible:ring-0"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Attach reference image"
                onClick={openFilePicker}
                disabled={disabled || !canAttachMore}
                className={cn(
                  'h-9 w-9 shrink-0 rounded-full text-adam-text-secondary hover:bg-adam-neutral-700 hover:text-white',
                  (disabled || !canAttachMore) && 'opacity-50',
                )}
              >
                <ImagePlus className="h-4 w-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            {canAttachMore
              ? 'Attach a reference image'
              : `Up to ${AGENT_MAX_REFERENCE_IMAGES} images per message`}
          </TooltipContent>
        </Tooltip>
        {isLoading && stopGenerating ? (
          <Button
            type="button"
            size="icon"
            aria-label="Stop generating"
            onClick={stopGenerating}
            className="h-9 w-9 shrink-0 rounded-full"
          >
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            aria-label="Send message"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={cn(
              'h-9 w-9 shrink-0 rounded-full',
              !canSubmit && 'opacity-50',
            )}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
