import { CreativePreviewSection } from '@/components/viewer/CreativePreviewSection';
import { useIsMobile } from '@/hooks/useIsMobile';
import {
  CHAT_PANEL_BOUNDS,
  PREVIEW_PANEL_BOUNDS,
  useChatPanelSizes,
} from '@/hooks/useChatPanelSizes';
import { Content, Message, Model } from '@shared/types';
import {
  ImperativePanelHandle,
  Panel,
  PanelGroup,
} from 'react-resizable-panels';
import { ChatSection } from '@/components/chat/ChatSection';
import { ChatPanelResizeHandle } from '@/components/chat/ChatPanelResizeHandle';
import { useRef, useState, useCallback } from 'react';
import { TreeNode } from '@shared/Tree';
import { CreativePreviewDialog } from '@/components/viewer/CreativePreviewDialog';

type CreativeViewProps = {
  messages: TreeNode<Message>[];
  generationMessages?: Message[];
  isLoading: boolean;
  sendMessage?: (content: Content) => void;
  stopGenerating?: () => void;
  restoreMessage?: (message: Message) => void;
  retryMessage?: ({ model, id }: { model: Model; id: string }) => void;
  editMessage?: (message: Message) => void;
  changeRating?: ({
    messageId,
    rating,
  }: {
    messageId: string;
    rating: number;
  }) => void;
  upscaleMessage?: ({
    meshId,
    parentMessageId,
  }: {
    meshId: string;
    parentMessageId: string | null;
  }) => void;
};

export function CreativeView({
  messages,
  generationMessages = [],
  isLoading,
  sendMessage,
  stopGenerating,
  restoreMessage,
  retryMessage,
  editMessage,
  changeRating,
  upscaleMessage,
}: CreativeViewProps) {
  const isMobile = useIsMobile();
  const panelRef = useRef<ImperativePanelHandle>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);

  const { setContainerRef, panelSizes } = useChatPanelSizes(CHAT_PANEL_BOUNDS);

  // Optimized collapse/expand handlers
  const handleCollapse = useCallback(() => {
    const panel = panelRef.current;
    if (panel) {
      panel.collapse();
      setIsCollapsed(true);
    }
  }, []);

  const handleExpand = useCallback(() => {
    const panel = panelRef.current;
    if (panel) {
      panel.expand();
      setIsCollapsed(false);
    }
  }, []);

  return (
    <>
      <div
        className="flex h-full w-full overflow-hidden bg-[#292828]"
        ref={isMobile ? undefined : setContainerRef}
      >
        {isMobile ? (
          <>
            <CreativePreviewDialog />
            <ChatSection
              messages={messages}
              isLoading={isLoading}
              onSendMessage={sendMessage}
              stopGenerating={stopGenerating}
              restoreMessage={restoreMessage}
              retryMessage={retryMessage}
              onEdit={editMessage}
              changeRating={changeRating}
              upscaleMessage={upscaleMessage}
            />
          </>
        ) : (
          <PanelGroup direction="horizontal" className="w-full">
            <Panel
              collapsible
              ref={panelRef}
              defaultSize={panelSizes.defaultSize}
              minSize={panelSizes.minSize}
              maxSize={panelSizes.maxSize}
            >
              <ChatSection
                messages={messages}
                isLoading={isLoading}
                onSendMessage={sendMessage}
                stopGenerating={stopGenerating}
                restoreMessage={restoreMessage}
                retryMessage={retryMessage}
                onEdit={editMessage}
                changeRating={changeRating}
                upscaleMessage={upscaleMessage}
              />
            </Panel>
            <ChatPanelResizeHandle
              isCollapsed={isCollapsed}
              onCollapse={handleCollapse}
              onExpand={handleExpand}
            />
            <Panel
              defaultSize={PREVIEW_PANEL_BOUNDS.defaultSize}
              minSize={PREVIEW_PANEL_BOUNDS.minSize}
              className="overflow-hidden"
            >
              <CreativePreviewSection
                isLoading={isLoading}
                generationMessages={generationMessages}
              />
            </Panel>
          </PanelGroup>
        )}
      </div>
    </>
  );
}
