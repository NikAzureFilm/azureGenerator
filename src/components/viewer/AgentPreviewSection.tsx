import { Loader2, Sparkles } from 'lucide-react';
import { Message } from '@shared/types';
import { cn } from '@/lib/utils';
import { ImageViewer } from '@/components/ImageViewer';
import { useCurrentMessage } from '@/contexts/CurrentMessageContext';
import { GenerationHistoryStrip } from '@/components/viewer/CreativePreviewSection';

interface AgentPreviewSectionProps {
  // Assistant messages along the active branch that carry concept images,
  // oldest first.
  conceptMessages: Message[];
  isLoading: boolean;
}

// Right-hand pane of the design-agent editor: the concept image the chat is
// currently talking about, plus a strip of the earlier concepts so a rejected
// direction stays one click away.
export function AgentPreviewSection({
  conceptMessages,
  isLoading,
}: AgentPreviewSectionProps) {
  const { currentMessage, setCurrentMessage } = useCurrentMessage();

  const latestConcept = conceptMessages[conceptMessages.length - 1];
  // The chat can select a specific image (clicking one sets the current
  // message); otherwise the newest concept is what the agent just rendered.
  const activeMessage = currentMessage?.content.images?.length
    ? currentMessage
    : latestConcept;
  const images = activeMessage?.content.images ?? [];
  const selectedIndex = activeMessage?.content.index;
  const imageIndex =
    typeof selectedIndex === 'number' && selectedIndex < images.length
      ? selectedIndex
      : images.length - 1;
  const image = images[imageIndex];
  const hasHistory = conceptMessages.length > 1;

  return (
    <div className="relative flex h-full w-full flex-col bg-adam-neutral-700">
      <div
        className={cn(
          'flex min-h-0 flex-1 items-center justify-center p-6',
          hasHistory && 'pb-24',
        )}
      >
        {image ? (
          <ImageViewer
            key={image}
            image={image}
            fit="contain"
            className="h-full max-h-full max-w-none rounded-xl"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-center text-adam-text-secondary">
            {isLoading ? (
              <>
                <Loader2 className="h-8 w-8 animate-spin" />
                <span className="text-sm">Sketching a concept...</span>
              </>
            ) : (
              <>
                <Sparkles className="h-8 w-8 text-adam-blue" />
                <span className="max-w-xs text-sm">
                  Concept images the agent sketches with you appear here.
                </span>
              </>
            )}
          </div>
        )}
      </div>
      {hasHistory && (
        <GenerationHistoryStrip
          label="Concepts"
          messages={conceptMessages}
          selectedMessageId={activeMessage?.id ?? null}
          onSelect={setCurrentMessage}
        />
      )}
    </div>
  );
}
