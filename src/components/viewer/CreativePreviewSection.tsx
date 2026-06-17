import { LazyMeshPreview } from './LazyMeshPreview';
import { ImageGallery } from './ImageGallery';
import { useCurrentMessage } from '@/contexts/CurrentMessageContext';
import { useConversation } from '@/contexts/ConversationContext';
import { CreativeLoadingBar } from './CreativeLoadingBar';
import { normalizeCreativeModel, type Message } from '@shared/types';
import { Box, History, ImageIcon, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ImageViewer } from '@/components/ImageViewer';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

interface CreativePreviewSectionProps {
  isLoading: boolean;
  generationMessages?: Message[];
}

export function CreativePreviewSection({
  isLoading,
  generationMessages = [],
}: CreativePreviewSectionProps) {
  const { currentMessage: message, setCurrentMessage } = useCurrentMessage();
  const { conversation } = useConversation();
  const hasGenerationHistory = generationMessages.length > 1;

  return (
    <div className="relative flex h-full w-full items-center justify-center bg-adam-neutral-700">
      {isLoading ? (
        <div className="flex h-full w-full items-center justify-center">
          <CreativeLoadingBar
            modelName={normalizeCreativeModel(
              message?.content.model ?? conversation.settings?.model,
            )}
          />
        </div>
      ) : (
        <div
          className={cn(
            'flex h-full w-full flex-1 flex-col items-center justify-center gap-2',
            hasGenerationHistory && 'pb-24',
          )}
        >
          {message?.content.images && Array.isArray(message.content.images) && (
            <ImageGallery imageIds={message.content.images} />
          )}
          {message?.content.mesh && (
            <LazyMeshPreview meshId={message.content.mesh.id} />
          )}
        </div>
      )}
      {hasGenerationHistory && (
        <GenerationHistoryStrip
          messages={generationMessages}
          selectedMessageId={message?.id ?? null}
          onSelect={setCurrentMessage}
        />
      )}
    </div>
  );
}

function GenerationHistoryStrip({
  messages,
  selectedMessageId,
  onSelect,
}: {
  messages: Message[];
  selectedMessageId: string | null;
  onSelect: (message: Message) => void;
}) {
  return (
    <div className="border-adam-neutral-600 absolute inset-x-0 bottom-0 border-t bg-adam-neutral-950/90 px-4 py-3 shadow-[0_-12px_32px_rgba(0,0,0,0.25)] backdrop-blur">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex shrink-0 items-center gap-2 text-xs font-medium text-adam-neutral-300">
          <History className="h-4 w-4" />
          <span>Generations</span>
        </div>
        <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1">
          {messages.map((generation, index) => {
            const isSelected = generation.id === selectedMessageId;
            return (
              <button
                key={generation.id}
                type="button"
                aria-label={`Open generation ${index + 1}`}
                aria-pressed={isSelected}
                onClick={() => onSelect(generation)}
                className={cn(
                  'relative h-16 w-16 shrink-0 overflow-hidden rounded-md border bg-adam-neutral-800 text-left transition-colors',
                  isSelected
                    ? 'border-adam-blue ring-2 ring-adam-blue/40'
                    : 'border-adam-neutral-600 hover:border-adam-neutral-300',
                )}
              >
                <span className="absolute left-1 top-1 z-10 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                  v{index + 1}
                </span>
                <GenerationHistoryThumbnail message={generation} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function GenerationHistoryThumbnail({ message }: { message: Message }) {
  if (message.content.mesh) {
    return <MeshGenerationThumbnail meshId={message.content.mesh.id} />;
  }

  if (message.content.images?.[0]) {
    return (
      <ImageViewer
        image={message.content.images[0]}
        clickable={false}
        hoverable={false}
        className="h-full w-full rounded-none"
      />
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center text-adam-neutral-300">
      <ImageIcon className="h-5 w-5" />
    </div>
  );
}

function MeshGenerationThumbnail({ meshId }: { meshId: string }) {
  const { conversation } = useConversation();
  const { data, isLoading, isError } = useQuery({
    queryKey: [
      'meshPreviewImage',
      conversation.user_id,
      conversation.id,
      meshId,
    ],
    enabled: !!conversation.user_id && !!conversation.id && !!meshId,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const { data: blob, error } = await supabase.storage
        .from('images')
        .download(
          `${conversation.user_id}/${conversation.id}/preview-${meshId}`,
        );

      if (error || !blob) {
        throw error ?? new Error('Mesh preview image not found');
      }

      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center text-adam-neutral-300">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex h-full w-full items-center justify-center text-adam-neutral-300">
        <Box className="h-5 w-5" />
      </div>
    );
  }

  return (
    <img
      src={data}
      alt="Preview render of the generated 3D object"
      className="h-full w-full object-cover"
    />
  );
}
