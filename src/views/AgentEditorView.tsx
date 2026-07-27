import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import posthog from 'posthog-js';
import { Box, Loader2, Ruler, Images, Sparkles } from 'lucide-react';
import {
  ImperativePanelHandle,
  Panel,
  PanelGroup,
} from 'react-resizable-panels';
import Tree from '@shared/Tree';
import {
  AgentPipeline,
  Content,
  Conversation,
  DEFAULT_CREATIVE_MODEL,
  Message,
} from '@shared/types';
import {
  getCreativeModelTokenCost,
  getParametricModelTokenCost,
  formatTokenCost,
} from '@shared/tokenCosts';
import { normalizeImageGenerationModel } from '@shared/imageGeneration';
import { DEFAULT_PARAMETRIC_MODEL } from '@/lib/parametricModels';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useConversation } from '@/contexts/ConversationContext';
import { useCurrentMessage } from '@/contexts/CurrentMessageContext';
import {
  useMessagesQuery,
  useSendContentMutation,
} from '@/services/messageService';
import { useRequestCancellation } from '@/hooks/useRequestCancellation';
import {
  CHAT_PANEL_BOUNDS,
  PREVIEW_PANEL_BOUNDS,
  useChatPanelSizes,
} from '@/hooks/useChatPanelSizes';
import { useIsMobile } from '@/hooks/useIsMobile';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { ChatPanelResizeHandle } from '@/components/chat/ChatPanelResizeHandle';
import { AgentComposer } from '@/components/AgentComposer';
import {
  readAgentPrintOptions,
  type AgentPrintOptions,
} from '@/utils/agentPrintOptions';
import { AgentPreviewSection } from '@/components/viewer/AgentPreviewSection';
import { AssistantMessage } from '@/components/chat/AssistantMessage';
import { UserMessage } from '@/components/chat/UserMessage';
import { AssistantLoading } from '@/components/chat/AssistantLoading';
import { ChatTitle } from '@/components/chat/ChatTitle';
import { LimitReachedMessage } from '@/components/LimitReachedMessage';
import { buildAgentHandoffPrompt } from '@/utils/agentHandoff';

const PIPELINE_META: Record<
  AgentPipeline,
  { label: string; description: string; icon: typeof Box }
> = {
  cad: {
    label: 'CAD Engineering',
    description: 'Precise parametric part with editable dimensions',
    icon: Ruler,
  },
  mesh: {
    label: 'Mesh Generation',
    description: 'Organic 3D mesh from the concept image',
    icon: Box,
  },
  multiview: {
    label: 'Multiview Mesh',
    description: 'Four-view mesh — you complete the remaining views next',
    icon: Images,
  },
};

function pipelineTokenCost(pipeline: AgentPipeline): number {
  if (pipeline === 'cad') {
    return getParametricModelTokenCost(DEFAULT_PARAMETRIC_MODEL);
  }
  if (pipeline === 'multiview') {
    return getCreativeModelTokenCost('multiview');
  }
  return getCreativeModelTokenCost(DEFAULT_CREATIVE_MODEL);
}

export function AgentEditorView() {
  const { conversation, updateConversationAsync } = useConversation();
  const { setCurrentMessage } = useCurrentMessage();
  const { billing } = useAuth();
  const { cancelRequest } = useRequestCancellation();
  const isMobile = useIsMobile();
  const totalTokens = billing?.tokens.total ?? 0;
  const limitReached = totalTokens <= 0;

  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const currentProcessingMessageRef = useRef<string | null>(null);
  const chatPanelRef = useRef<ImperativePanelHandle>(null);
  const [isChatCollapsed, setIsChatCollapsed] = useState(false);
  const [selectedPipeline, setSelectedPipeline] =
    useState<AgentPipeline | null>(null);

  // Print constraints live on the conversation row so the edge function reads
  // them on every turn (including replays) and the handoff can pass them on.
  // Conversations started before the option existed have no keys — default
  // `threeDPrint` on to keep the printability rules they were designed under.
  const printOptions: AgentPrintOptions = useMemo(
    () => readAgentPrintOptions(conversation.settings),
    [conversation.settings],
  );

  const handlePrintOptionsChange = useCallback(
    (next: AgentPrintOptions) => {
      void updateConversationAsync?.({
        ...conversation,
        settings: {
          ...conversation.settings,
          threeDPrint: next.threeDPrint,
          flatBottom: next.flatBottom,
        },
      });
    },
    [conversation, updateConversationAsync],
  );

  const { setContainerRef, panelSizes } = useChatPanelSizes(CHAT_PANEL_BOUNDS);

  const { data: messages = [] } = useMessagesQuery();

  const { mutate: sendAgentMessage, isPending: isSendingMessage } =
    useSendContentMutation({ conversation });

  const isAgentStreaming = useIsMutating({
    mutationKey: ['agent-chat', conversation.id],
  });
  const isLoading = !!isAgentStreaming || isSendingMessage;

  const lastMessage = useMemo(() => {
    if (conversation.current_message_leaf_id) {
      return messages.find(
        (msg) => msg.id === conversation.current_message_leaf_id,
      );
    }
    return messages[messages.length - 1];
  }, [messages, conversation.current_message_leaf_id]);

  const messageTree = useMemo(() => new Tree<Message>(messages), [messages]);

  const currentMessageBranch = useMemo(
    () => messageTree.getPath(lastMessage?.id ?? ''),
    [lastMessage, messageTree],
  );

  // Latest recommendation and concept image along the active branch.
  const recommendation = useMemo(() => {
    for (let index = currentMessageBranch.length - 1; index >= 0; index -= 1) {
      const message = currentMessageBranch[index];
      if (message.role === 'assistant' && message.content.recommendation) {
        return message.content.recommendation;
      }
    }
    return undefined;
  }, [currentMessageBranch]);

  // The image handed off to the generation pipeline: the agent's latest
  // concept render, or — when it never rendered one — the newest reference
  // image the user attached.
  const conceptImageId = useMemo(() => {
    let userImageId: string | undefined;
    for (let index = currentMessageBranch.length - 1; index >= 0; index -= 1) {
      const message = currentMessageBranch[index];
      const images = message.content.images;
      if (!images?.length) continue;
      if (message.role === 'assistant') {
        return images[images.length - 1];
      }
      if (!userImageId) {
        userImageId = images[images.length - 1];
      }
    }
    return userImageId;
  }, [currentMessageBranch]);

  // Concepts the agent rendered along this branch — the preview pane shows the
  // newest one and lists the rest.
  const conceptMessages = useMemo(
    () =>
      currentMessageBranch.filter(
        (message) =>
          message.role === 'assistant' && !!message.content.images?.length,
      ),
    [currentMessageBranch],
  );

  const latestConceptMessage = conceptMessages[conceptMessages.length - 1];
  // Held in a ref so the effect below can depend on the id alone: refetches
  // hand back new message objects, and re-running on identity would fight a
  // user who selected an earlier concept.
  const latestConceptRef = useRef<Message | undefined>(undefined);
  latestConceptRef.current = latestConceptMessage;

  const lastUserText = useMemo(() => {
    for (let index = currentMessageBranch.length - 1; index >= 0; index -= 1) {
      const message = currentMessageBranch[index];
      if (message.role === 'user' && message.content.text?.trim()) {
        return message.content.text.trim();
      }
    }
    return '';
  }, [currentMessageBranch]);

  const pipeline: AgentPipeline =
    selectedPipeline ?? recommendation?.pipeline ?? 'mesh';

  const imageGenerationModel = normalizeImageGenerationModel(
    conversation.settings?.imageGenerationModel,
  );

  // The conversation shape this chat graduates into when the user clicks
  // Generate: settings.mode is dropped, type/model switch to the pipeline.
  const handoffConversation = useMemo(() => {
    const type = pipeline === 'cad' ? 'parametric' : 'creative';
    const model =
      pipeline === 'cad'
        ? DEFAULT_PARAMETRIC_MODEL
        : pipeline === 'multiview'
          ? 'multiview'
          : DEFAULT_CREATIVE_MODEL;
    const settings = {
      model,
      imageGenerationModel,
      // `mode: 'agent'` is intentionally dropped here, but the print options
      // are carried over so the graduated conversation keeps the constraints
      // the design was agreed under.
      threeDPrint: printOptions.threeDPrint,
      flatBottom: printOptions.flatBottom,
      ...(pipeline === 'multiview' && conceptImageId
        ? { multiviewImages: { front: conceptImageId } }
        : {}),
    };
    return { ...conversation, type, settings } as Conversation;
  }, [
    conversation,
    pipeline,
    imageGenerationModel,
    conceptImageId,
    printOptions,
  ]);

  const { mutate: sendHandoffContent, isPending: isHandingOff } =
    useSendContentMutation({ conversation: handoffConversation });

  const handleGenerate = useCallback(async () => {
    if (isLoading || isHandingOff || limitReached) return;

    posthog.capture('agent_handoff', {
      pipeline,
      conversation_id: conversation.id,
      has_concept_image: !!conceptImageId,
    });

    // Graduate the conversation first so the editor view flips and future
    // sends route to the chosen pipeline.
    await updateConversationAsync?.(handoffConversation);

    // Multiview needs the user to complete the remaining views in the
    // multiview composer (seeded with the concept image as the front view).
    if (pipeline === 'multiview') return;

    const text = buildAgentHandoffPrompt(
      recommendation?.generationPrompt?.trim() || lastUserText,
      pipeline,
      printOptions.flatBottom,
    );

    const content: Content = {
      text,
      model: handoffConversation.settings?.model,
      ...(conceptImageId ? { images: [conceptImageId] } : {}),
      ...(pipeline === 'mesh' ? { imageGenerationModel } : {}),
      // Structural flag, not just prose: creative-chat reads it off this
      // message to tell the mesh function, and it marks the result for the
      // planar bottom cut.
      ...(printOptions.flatBottom ? { flatBottom: true } : {}),
    };

    sendHandoffContent(content);
  }, [
    isLoading,
    isHandingOff,
    limitReached,
    pipeline,
    conversation.id,
    conceptImageId,
    updateConversationAsync,
    handoffConversation,
    recommendation?.generationPrompt,
    lastUserText,
    imageGenerationModel,
    sendHandoffContent,
    printOptions.flatBottom,
  ]);

  const sendMessage = useCallback(
    (content: Content) => {
      posthog.capture('message_sent', {
        type: 'agent',
        text: content.text ?? '',
        conversation_id: conversation.id,
      });
      sendAgentMessage(content);
    },
    [sendAgentMessage, conversation.id],
  );

  // Track the in-flight user message for Stop generating.
  useEffect(() => {
    if (isLoading && lastMessage) {
      currentProcessingMessageRef.current =
        lastMessage.role === 'assistant'
          ? lastMessage.parent_message_id || null
          : lastMessage.id;
    } else if (!isLoading) {
      currentProcessingMessageRef.current = null;
    }
  }, [lastMessage, isLoading]);

  const stopGenerating = useCallback(async () => {
    if (currentProcessingMessageRef.current) {
      try {
        await cancelRequest(currentProcessingMessageRef.current);
        currentProcessingMessageRef.current = null;
      } catch (error) {
        console.error('Failed to cancel request:', error);
      }
    }
  }, [cancelRequest]);

  useEffect(() => {
    setCurrentMessage(null);
  }, [conversation.id, setCurrentMessage]);

  // Follow the newest concept in the preview pane. On mobile there is no pane,
  // so the images stay inline in the chat.
  useEffect(() => {
    if (isMobile) return;
    const message = latestConceptRef.current;
    if (message) {
      setCurrentMessage(message);
    }
  }, [latestConceptMessage?.id, isMobile, setCurrentMessage]);

  const collapseChat = useCallback(() => {
    chatPanelRef.current?.collapse();
    setIsChatCollapsed(true);
  }, []);

  const expandChat = useCallback(() => {
    chatPanelRef.current?.expand();
    setIsChatCollapsed(false);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (scrollAreaRef.current) {
      const scrollContainer = scrollAreaRef.current.querySelector(
        '[data-radix-scroll-area-viewport]',
      );
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading, scrollToBottom]);

  const getCurrentVersion = useCallback(
    (index: number) =>
      currentMessageBranch
        .slice(0, index + 1)
        .filter((m) => m.role === 'assistant').length,
    [currentMessageBranch],
  );

  const showRecommendationPanel = !!recommendation && !isLoading;

  // Tap-able answer options for the agent's latest clarifying question. Only
  // the leaf assistant message's question is answerable — answering moves the
  // leaf, which hides the buttons.
  const activeQuestion =
    !isLoading && lastMessage?.role === 'assistant'
      ? lastMessage.content.question
      : undefined;

  // Messages, the recommendation panel and the composer. The panel bounds the
  // width on desktop; the max-w cap keeps the mobile single column centered.
  const chatColumn = (
    <div className="flex h-full min-h-0 w-full flex-col items-center overflow-hidden">
      <ScrollArea
        className="relative w-full max-w-2xl flex-1 px-2 py-0"
        ref={scrollAreaRef}
      >
        <div className="space-y-4 pb-6">
          {currentMessageBranch.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-4 pt-16 text-center text-adam-text-secondary">
              <Sparkles className="h-8 w-8 text-adam-blue" />
              <p className="text-sm">
                Describe what you want to build. The agent will sketch concept
                images with you, then pick the best generation pipeline.
              </p>
            </div>
          )}
          {currentMessageBranch.map((message, index) => (
            <div className="p-1" key={message.id}>
              {message.role === 'assistant' ? (
                <AssistantMessage
                  message={message}
                  isLoading={isLoading}
                  currentVersion={getCurrentVersion(index)}
                  limitReached={limitReached}
                />
              ) : (
                <UserMessage
                  message={message}
                  isLoading={isLoading}
                  limitReached={limitReached}
                />
              )}
            </div>
          ))}
          {isLoading && lastMessage?.role !== 'assistant' && (
            <AssistantLoading />
          )}
          {limitReached && <LimitReachedMessage />}
        </div>
      </ScrollArea>
      <div className="w-full min-w-52 max-w-2xl bg-transparent px-4 pb-6">
        {activeQuestion && !limitReached && (
          <div className="mb-3 flex flex-wrap gap-2">
            {activeQuestion.options.map((option) => (
              <Button
                key={option}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => sendMessage({ text: option })}
                className="h-8 rounded-full border-adam-neutral-700 bg-adam-neutral-800 px-3 text-xs text-adam-text-primary hover:bg-adam-neutral-700 hover:text-white"
              >
                {option}
              </Button>
            ))}
            <span className="self-center text-[11px] text-adam-text-tertiary">
              or type your own answer below
            </span>
          </div>
        )}
        {showRecommendationPanel && (
          <div className="mb-3 rounded-xl border border-adam-blue/30 bg-adam-neutral-800 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-adam-text-primary">
              <Sparkles className="h-4 w-4 text-adam-blue" />
              Ready to generate
            </div>
            {recommendation.reason && (
              <p className="mb-3 text-xs text-adam-text-secondary">
                {recommendation.reason}
              </p>
            )}
            <div className="mb-3 grid gap-2">
              {(Object.keys(PIPELINE_META) as AgentPipeline[]).map((key) => {
                const meta = PIPELINE_META[key];
                const Icon = meta.icon;
                const isSelected = key === pipeline;
                const isRecommended = key === recommendation.pipeline;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => setSelectedPipeline(key)}
                    className={cn(
                      'flex flex-col gap-1 rounded-lg border p-2 text-left transition-colors',
                      isSelected
                        ? 'border-adam-blue/70 bg-adam-blue/10'
                        : 'border-adam-neutral-700 hover:border-white/25',
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-xs font-medium text-adam-text-primary">
                      <Icon className="h-3.5 w-3.5" />
                      {meta.label}
                      {isRecommended && (
                        <span className="rounded-full bg-adam-blue/15 px-1.5 py-0.5 text-[10px] text-adam-blue">
                          Recommended
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] leading-4 text-adam-text-secondary">
                      {meta.description}
                    </span>
                  </button>
                );
              })}
            </div>
            <Button
              type="button"
              onClick={() => void handleGenerate()}
              disabled={isHandingOff || limitReached}
              className="w-full gap-2"
            >
              {isHandingOff ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {pipeline === 'multiview'
                ? 'Continue to multiview setup'
                : `Generate (${formatTokenCost(pipelineTokenCost(pipeline))})`}
            </Button>
          </div>
        )}
        <AgentComposer
          onSubmit={sendMessage}
          conversation={{
            id: conversation.id,
            user_id: conversation.user_id,
          }}
          isLoading={isLoading}
          disabled={limitReached}
          stopGenerating={stopGenerating}
          placeholder="Describe or refine your idea, or attach a reference image..."
          printOptions={printOptions}
          onPrintOptionsChange={handlePrintOptionsChange}
        />
      </div>
    </div>
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-adam-bg-secondary-dark">
      <div className="flex w-full items-center justify-between bg-transparent p-3 pl-12">
        <div className="min-w-0 flex-1">
          <ChatTitle />
        </div>
        <span className="flex items-center gap-1.5 rounded-full border border-adam-blue/30 bg-adam-blue/10 px-3 py-1 text-xs font-medium text-adam-blue">
          <Sparkles className="h-3.5 w-3.5" />
          Design Agent
        </span>
      </div>
      <div
        className="flex min-h-0 w-full flex-1"
        ref={isMobile ? undefined : setContainerRef}
      >
        {isMobile ? (
          chatColumn
        ) : (
          <PanelGroup direction="horizontal" className="w-full">
            <Panel
              collapsible
              ref={chatPanelRef}
              defaultSize={panelSizes.defaultSize}
              minSize={panelSizes.minSize}
              maxSize={panelSizes.maxSize}
            >
              {chatColumn}
            </Panel>
            <ChatPanelResizeHandle
              isCollapsed={isChatCollapsed}
              onCollapse={collapseChat}
              onExpand={expandChat}
            />
            <Panel
              defaultSize={PREVIEW_PANEL_BOUNDS.defaultSize}
              minSize={PREVIEW_PANEL_BOUNDS.minSize}
              className="overflow-hidden"
            >
              <AgentPreviewSection
                conceptMessages={conceptMessages}
                isLoading={isLoading}
              />
            </Panel>
          </PanelGroup>
        )}
      </div>
    </div>
  );
}
