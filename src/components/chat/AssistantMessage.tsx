import { Content, Message, Model } from '@shared/types';
import {
  ArrowUpRight,
  Box,
  ChevronLeft,
  ChevronRight,
  History,
  ThumbsDown,
  ThumbsUp,
  Download,
  Loader2,
  ImageIcon,
  MessageCircleQuestion,
  Globe,
  Sparkles,
} from 'lucide-react';
import { Streamdown } from 'streamdown';
import { StreamingCodeBlock } from '@/components/chat/StreamingCodeBlock';
import { GenerationErrorNotice } from '@/components/chat/GenerationErrorNotice';
import { BrandLogo } from '@/components/BrandLogo';
import { BRAND_WEBSITE } from '@/config/brand';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { cn, getBackupModel } from '@/lib/utils';
import { Link } from '@tanstack/react-router';
import { getLevel, useAuth } from '@/contexts/AuthContext';
import { ImageViewer } from '@/components/ImageViewer';
import { useConversation } from '@/contexts/ConversationContext';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';
import { useCurrentMessage } from '@/contexts/CurrentMessageContext';
import { useCallback, useMemo, useState } from 'react';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useMeshData } from '@/hooks/useMeshData';
import { MeshImagePreview } from '@/components/viewer/MeshImagePreview';
import { TreeNode } from '@shared/Tree';
import {
  downloadOBJArtifactFile,
  downloadSTEPArtifactFile,
} from '@/utils/downloadUtils';
import { isAssistantGenerationInFlight } from '@/utils/generationStatus';

const linkParametricMode = (text: string) =>
  text.replace(
    /(```[\s\S]*?```|`[^`\n]*`)|parametric mode/gi,
    (match, codeSpan) => codeSpan ?? `[${match}](${BRAND_WEBSITE})`,
  );

interface AssistantMessageProps {
  message: TreeNode<Message>;
  isLoading: boolean;
  currentVersion: number;
  changeRating?: ({
    messageId,
    rating,
  }: {
    messageId: string;
    rating: number;
  }) => void;
  onRetry?: ({ model, id }: { model: Model; id: string }) => void;
  onUpscale?: ({
    meshId,
    parentMessageId,
  }: {
    meshId: string;
    parentMessageId: string | null;
  }) => void;
  restoreMessage?: (message: Message) => void;
  limitReached?: boolean;
}

const paymentRequiredMessages = {
  insufficient_tokens: <InsufficientTokensMessage />,
  trial_user_E9ueHIgpei2JvFUDeJLEnwzDhy7GF38a: <FreeUserMessage />,
  free_user_E9ueHIgpei2JvFUDeJLEnwzDhy7GF38a: <FreeUserMessage />,
  limit_reached_E9ueHIgpei2JvFUDeJLEnwzDhy7GF38a: <LimitReachedMessage />,
  limit_reached_image_E9ueHIgpei2JvFUDeJLEnwzDhy7GF38a: (
    <ImageLimitReachedMessage />
  ),
  limit_reached_mesh_E9ueHIgpei2JvFUDeJLEnwzDhy7GF38a: (
    <MeshLimitReachedMessage />
  ),
};

export function AssistantMessage({
  message,
  isLoading,
  currentVersion,
  changeRating,
  restoreMessage,
  onRetry,
  onUpscale,
  limitReached,
}: AssistantMessageProps) {
  const { conversation, updateConversation } = useConversation();
  const { currentMessage, setCurrentMessage } = useCurrentMessage();
  const isMobile = useIsMobile();
  const model = getBackupModel({
    message,
    parentMessage: message.parent ?? undefined,
    type: conversation.type,
  });

  // Removed parameter diff banner from assistant message

  const changeLeaf = useCallback(
    (messageId: string) => {
      updateConversation?.({
        ...conversation,
        current_message_leaf_id: messageId,
      });
    },
    [updateConversation, conversation],
  );

  const branchIndex = useMemo(
    () => message.siblings.findIndex((branch) => branch.id === message.id),
    [message.siblings, message.id],
  );

  const leafNodes = useMemo(
    () =>
      message.siblings.map((branch) => {
        let current = branch;
        while (current.children && current.children.length > 0) {
          current = current.children[0];
        }
        return current;
      }),
    [message.siblings],
  );

  // Fetch mesh data to check status
  const { data: meshDataQuery } = useMeshData({
    id: message.content.mesh?.id ?? '',
  });

  // Upscale functionality for quality/draft meshes - only show when mesh is complete
  const canUpscale =
    model === 'quality' &&
    message.content.mesh &&
    meshDataQuery.data?.status === 'success';

  const handleUpscale = useCallback(() => {
    if (!message.content.mesh || !onUpscale) return;

    onUpscale({
      meshId: message.content.mesh.id,
      parentMessageId: message.parent_message_id,
    });
  }, [message.content.mesh, message.parent_message_id, onUpscale]);

  // Check if this message is the last one in the conversation
  const isLastMessage = conversation.current_message_leaf_id === message.id;

  const markdownText = useMemo(
    () =>
      message.content.text ? linkParametricMode(message.content.text) : '',
    [message.content.text],
  );
  const visibleToolCalls = message.content.toolCalls ?? [];
  const showRestoredCreativeLoading =
    conversation.type === 'creative' &&
    isAssistantGenerationInFlight(message) &&
    !message.content.text &&
    !message.content.mesh &&
    !message.content.artifact &&
    (!message.content.images || message.content.images.length === 0) &&
    visibleToolCalls.length === 0;

  return (
    <div className="flex justify-start">
      {message.role === 'assistant' && (
        <div className="mr-2 mt-1">
          <Avatar className="h-9 w-9 border border-adam-neutral-700 bg-adam-neutral-950">
            <div style={{ padding: '0.6rem 0.5rem 0.5rem 0.55rem' }}>
              <BrandLogo variant="mark" className="h-full w-full" />
            </div>
          </Avatar>
        </div>
      )}
      <div
        className={cn(
          'w-[80%] rounded-lg bg-adam-neutral-800',
          isMobile && message.content.mesh && 'w-full',
        )}
      >
        <div className="flex flex-col gap-3 p-3 text-sm text-adam-text-primary">
          {message.content.error ? (
            <>
              {message.content.error in paymentRequiredMessages ? (
                paymentRequiredMessages[
                  message.content.error as keyof typeof paymentRequiredMessages
                ]
              ) : message.content.text &&
                message.content.text in paymentRequiredMessages ? (
                paymentRequiredMessages[
                  message.content.text as keyof typeof paymentRequiredMessages
                ]
              ) : (
                <GenerationErrorNotice
                  error={message.content.error}
                  onRetry={
                    onRetry && message.parent_message_id && model
                      ? () => onRetry({ model, id: message.parent_message_id! })
                      : undefined
                  }
                  disabled={isLoading || limitReached}
                />
              )}
            </>
          ) : (
            <>
              {conversation.type === 'parametric' &&
                !message.content.text &&
                (!message.content.toolCalls ||
                  message.content.toolCalls.length === 0) &&
                !message.content.artifact &&
                !message.content.mesh &&
                (!message.content.images ||
                  message.content.images.length === 0) && (
                  <div className="flex h-10 w-full items-center justify-between overflow-hidden rounded-md bg-adam-neutral-950 px-3">
                    <div className="flex h-full items-center justify-center gap-2">
                      <Box className="h-4 w-4 text-white" />
                      <span>Generating model...</span>
                    </div>
                    <Loader2 className="h-4 w-4 animate-spin text-white" />
                  </div>
                )}
              {showRestoredCreativeLoading && (
                <div className="flex h-10 w-full items-center justify-between overflow-hidden rounded-md bg-adam-neutral-950 px-3">
                  <div className="flex h-full items-center justify-center gap-2">
                    <Box className="h-4 w-4 text-white" />
                    <span>Generating mesh...</span>
                  </div>
                  <Loader2 className="h-4 w-4 animate-spin text-white" />
                </div>
              )}
              {message.content.text ? (
                <Streamdown
                  className="px-1 [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-adam-neutral-950 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_a]:text-adam-blue [&_a]:underline hover:[&_a]:opacity-80 [&_h1]:mt-2 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-1 [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_p:not(:last-child)]:mb-2 [&_p]:leading-relaxed [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-adam-neutral-950 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:list-disc [&_ul]:pl-5"
                  parseIncompleteMarkdown
                >
                  {markdownText}
                </Streamdown>
              ) : null}
              {visibleToolCalls.length > 0 && (
                <div className="flex w-full flex-col gap-2">
                  {visibleToolCalls.map((toolCall) => {
                    // For a pending parametric build, once code starts
                    // streaming swap the generic status row for the live
                    // code. Before the first chunk we keep the original
                    // status row so the thinking state is clear.
                    const streamingCode = message.content.artifact?.code ?? '';
                    if (
                      toolCall.name === 'build_parametric_model' &&
                      toolCall.status === 'pending' &&
                      streamingCode.length > 0
                    ) {
                      return (
                        <StreamingCodeBlock
                          key={toolCall.id ?? `${toolCall.name}`}
                          code={streamingCode}
                          isStreaming={true}
                        />
                      );
                    }

                    return (
                      <div
                        key={toolCall.id ?? `${toolCall.name}`}
                        className="flex h-10 w-full items-center justify-between overflow-hidden rounded-md bg-adam-neutral-950 px-3 hover:bg-adam-neutral-900"
                      >
                        <div className="flex h-full items-center justify-center gap-2">
                          {(toolCall.name === 'create_image' ||
                            toolCall.name === 'generate_concept_image') && (
                            <ImageIcon className="h-4 w-4 text-white" />
                          )}
                          {toolCall.name === 'web_search' && (
                            <Globe className="h-4 w-4 text-white" />
                          )}
                          {toolCall.name === 'create_mesh' && (
                            <Box className="h-4 w-4 text-white" />
                          )}
                          {(toolCall.name === 'build_parametric_model' ||
                            toolCall.name === 'apply_parameter_changes') && (
                            <Box className="h-4 w-4 text-white" />
                          )}
                          {toolCall.status === 'pending' && (
                            <span>
                              {toolCall.name === 'create_image'
                                ? 'Queuing image...'
                                : toolCall.name === 'generate_concept_image'
                                  ? 'Creating concept image...'
                                  : toolCall.name === 'web_search'
                                    ? 'Searching the web...'
                                    : toolCall.name === 'create_mesh'
                                      ? 'Queuing mesh...'
                                      : toolCall.name ===
                                            'build_parametric_model' ||
                                          toolCall.name ===
                                            'apply_parameter_changes'
                                        ? 'Generating model...'
                                        : `${toolCall.name}...`}
                            </span>
                          )}
                          {toolCall.status === 'error' && (
                            <span>
                              {toolCall.name === 'create_image'
                                ? 'Failed to start image generation'
                                : toolCall.name === 'generate_concept_image'
                                  ? 'Failed to generate concept image'
                                  : toolCall.name === 'web_search'
                                    ? 'Web search failed'
                                    : toolCall.name === 'create_mesh'
                                      ? 'Failed to start mesh generation'
                                      : toolCall.name ===
                                            'build_parametric_model' ||
                                          toolCall.name ===
                                            'apply_parameter_changes'
                                        ? 'Failed to generate model'
                                        : `${toolCall.name}...`}
                            </span>
                          )}
                        </div>
                        {toolCall.status === 'pending' && (
                          <Loader2 className="h-4 w-4 animate-spin text-white" />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <AssistantMessageImagesViewer message={message} />
              {message.content.question && (
                <div className="flex items-start gap-2 rounded-md bg-adam-neutral-950 px-3 py-2">
                  <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0 text-adam-blue" />
                  <span>{message.content.question.text}</span>
                </div>
              )}
              {message.content.mesh && (
                <div
                  onClick={() => {
                    if (currentMessage && message.id === currentMessage?.id) {
                      setCurrentMessage(null);
                    } else {
                      setCurrentMessage(message);
                    }
                  }}
                  className={cn(
                    'cursor-pointer overflow-hidden rounded-md',
                    currentMessage?.id === message.id &&
                      'outline outline-2 outline-adam-blue',
                  )}
                >
                  <MeshImagePreview meshId={message.content.mesh.id} />
                </div>
              )}
              {message.content.cadJob && (
                <CadJobArtifactDownloads message={message} />
              )}
              {message.content.artifact &&
                !visibleToolCalls.some(
                  (c) =>
                    c.name === 'build_parametric_model' &&
                    c.status === 'pending',
                ) && (
                  <ObjectButton
                    message={message}
                    currentMessage={currentMessage}
                    setCurrentMessage={setCurrentMessage}
                    currentVersion={currentVersion}
                  />
                )}
              {message.content.loop && (
                <LoopStatusLine loop={message.content.loop} />
              )}
            </>
          )}

          {(updateConversation ||
            changeRating ||
            canUpscale ||
            (message.siblings.length > 1 && updateConversation) ||
            (restoreMessage && !isLastMessage)) && (
            <div className="flex flex-wrap items-center gap-1 gap-y-2">
              {changeRating && (
                <div className="flex items-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label="Rate response as good"
                        onClick={() =>
                          changeRating({
                            messageId: message.id,
                            rating: 1,
                          })
                        }
                        className="h-6 w-6 rounded-lg rounded-r-none border-r-0 p-0 pl-0.5"
                      >
                        <ThumbsUp
                          className={`h-3 w-3 ${message.rating === 1 ? 'text-adam-blue' : 'text-adam-neutral-100'}`}
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <span>Good response</span>
                    </TooltipContent>
                  </Tooltip>
                  <Separator
                    orientation="vertical"
                    className="h-6 bg-adam-neutral-700"
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label="Rate response as bad"
                        onClick={() =>
                          changeRating({
                            messageId: message.id,
                            rating: -1,
                          })
                        }
                        className="h-6 w-6 rounded-lg rounded-l-none border-l-0 p-0 pr-0.5"
                      >
                        <ThumbsDown
                          className={`h-3 w-3 ${message.rating === -1 ? 'text-adam-blue' : 'text-adam-neutral-100'}`}
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <span>Bad response</span>
                    </TooltipContent>
                  </Tooltip>
                </div>
              )}
              {restoreMessage && !isLastMessage && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label="Restore this version"
                      onClick={() => restoreMessage(message)}
                      disabled={isLoading}
                      className="h-6 w-6 rounded-lg p-0"
                    >
                      <History className="h-3 w-3 p-0 text-adam-neutral-100" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <span>Restore</span>
                  </TooltipContent>
                </Tooltip>
              )}

              {message.parent_message_id && onRetry && (
                <div className="flex items-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon"
                        variant="outline"
                        aria-label="Retry generation"
                        onClick={() => {
                          onRetry({ model, id: message.parent_message_id! });
                        }}
                        disabled={isLoading || limitReached}
                        className={cn(
                          'h-6 w-6 rounded-lg p-0',
                          limitReached && 'cursor-not-allowed opacity-50',
                        )}
                      >
                        <RefreshCw className="h-3 w-3 p-0 text-adam-neutral-100" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <span>Retry</span>
                    </TooltipContent>
                  </Tooltip>
                </div>
              )}
              {canUpscale && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleUpscale}
                      disabled={isLoading || limitReached}
                      className={cn(
                        'h-6 gap-1 rounded-lg px-2 text-xs',
                        limitReached && 'cursor-not-allowed opacity-50',
                      )}
                    >
                      <Sparkles className="h-3 w-3" />
                      <span>Upscale</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <span>
                      {limitReached
                        ? 'No generations remaining'
                        : 'Upscale your 3D asset quality'}
                    </span>
                  </TooltipContent>
                </Tooltip>
              )}
              {message.siblings.length > 1 && updateConversation && (
                <div className="flex h-6 items-center gap-0.5 rounded-lg border border-adam-neutral-700 bg-adam-bg-secondary-dark">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex h-full">
                        <Button
                          disabled={branchIndex === 0 || isLoading}
                          variant="outline"
                          size="icon"
                          aria-label="Previous version"
                          onClick={() => {
                            changeLeaf(leafNodes[branchIndex - 1].id);
                          }}
                          className="h-full w-6 rounded-lg rounded-r-none border-none p-0"
                        >
                          <ChevronLeft className="h-3 w-3 p-0 text-adam-neutral-100" />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <span>Previous version</span>
                    </TooltipContent>
                  </Tooltip>
                  <span className="text-xs tracking-widest text-adam-neutral-100">
                    {branchIndex + 1}/{message.siblings.length}
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex h-full">
                        <Button
                          disabled={
                            branchIndex === message.siblings.length - 1 ||
                            isLoading
                          }
                          variant="outline"
                          size="icon"
                          aria-label="Next version"
                          onClick={() => {
                            changeLeaf(leafNodes[branchIndex + 1].id);
                          }}
                          className="h-full w-6 rounded-lg rounded-l-none border-none p-0"
                        >
                          <ChevronRight className="h-3 w-3 p-0 text-adam-neutral-100" />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <span>Next version</span>
                    </TooltipContent>
                  </Tooltip>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Lightweight progress line for the agentic generation loop, driven off the
// message's persisted loop state. Renders only for the non-terminal states the
// client sees while a loop is actively driving; terminal loops render nothing.
function LoopStatusLine({ loop }: { loop: NonNullable<Content['loop']> }) {
  let label: string | null = null;
  if (loop.status === 'reviewing') {
    label = 'Reviewing model...';
  } else if (loop.status === 'generating') {
    label = 'Improving model...';
  } else if (loop.status === 'awaiting_client') {
    label = 'Checking model...';
  }
  if (!label) return null;

  return (
    <div className="flex h-10 w-full items-center justify-between overflow-hidden rounded-md bg-adam-neutral-950 px-3">
      <div className="flex h-full items-center justify-center gap-2">
        <Sparkles className="h-4 w-4 text-white" />
        <span>{label}</span>
      </div>
      <Loader2 className="h-4 w-4 animate-spin text-white" />
    </div>
  );
}

function CadJobArtifactDownloads({ message }: { message: Message }) {
  const cadJob = message.content.cadJob;
  const artifacts = cadJob?.artifacts;
  const [downloadingFormat, setDownloadingFormat] = useState<
    'step' | 'obj' | null
  >(null);

  if (cadJob?.status !== 'success' || !artifacts) {
    return null;
  }

  const canDownloadSTEP = !!artifacts.stepPath;
  const canDownloadOBJ = !!artifacts.stlPath;
  const isDownloading = downloadingFormat !== null;

  const handleDownloadSTEP = async () => {
    if (!artifacts.stepPath) return;
    try {
      setDownloadingFormat('step');
      await downloadSTEPArtifactFile(artifacts.stepPath, message);
    } catch (error) {
      console.error('[CAD] Failed to download STEP artifact:', error);
    } finally {
      setDownloadingFormat(null);
    }
  };

  const handleDownloadOBJ = async () => {
    if (!artifacts.stlPath) return;
    try {
      setDownloadingFormat('obj');
      await downloadOBJArtifactFile(artifacts.stlPath, message);
    } catch (error) {
      console.error('[CAD] Failed to download OBJ artifact:', error);
    } finally {
      setDownloadingFormat(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-adam-neutral-950 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Box className="h-4 w-4 shrink-0 text-adam-text-primary" />
        <span className="truncate text-sm font-medium text-adam-text-primary">
          CAD exports
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canDownloadSTEP || isDownloading}
          onClick={handleDownloadSTEP}
          className="h-8 gap-1 rounded-md px-2 text-xs"
        >
          <Download className="h-3.5 w-3.5" />
          STEP
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canDownloadOBJ || isDownloading}
          onClick={handleDownloadOBJ}
          className="h-8 gap-1 rounded-md px-2 text-xs"
        >
          <Download className="h-3.5 w-3.5" />
          OBJ
        </Button>
      </div>
    </div>
  );
}

function ObjectButton({
  message,
  currentMessage,
  setCurrentMessage,
  currentVersion,
}: {
  message: Message;
  currentMessage: Message | null;
  setCurrentMessage: (message: Message) => void;
  currentVersion: number;
}) {
  const [isHovered, setIsHovered] = useState(false);
  let title = 'Generated Object';
  if (message.content.artifact) {
    title = message.content.artifact.title;
  }

  return (
    <Button
      variant="outline"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn(
        'group relative bg-black p-2 hover:bg-adam-bg-dark',
        currentMessage && currentMessage.id === message.id
          ? 'border-adam-blue'
          : 'border-gray-200/20 dark:border-gray-700',
      )}
      onClick={() => setCurrentMessage(message)}
    >
      <div className="flex w-full items-center justify-between border-gray-200/20 pr-16 dark:border-gray-700">
        <div className="flex min-w-0 items-center space-x-2">
          <Box className="h-4 w-4 shrink-0 text-adam-text-primary" />
          <span className="truncate font-medium text-adam-text-primary">
            {title}
          </span>
        </div>
        <span
          className={cn(
            'absolute right-2 flex h-6 items-center overflow-hidden rounded-md border border-adam-neutral-700 bg-adam-bg-secondary-dark px-1 text-xs transition-all duration-100 ease-in-out hover:bg-black',
            isHovered
              ? 'w-14 text-adam-text-primary'
              : `w-${6 + (currentVersion.toString().length - 1)} text-adam-neutral-300`,
          )}
        >
          {isHovered ? (
            <div className="flex items-center gap-1">
              Open
              <ArrowUpRight className="h-3 w-3" />
            </div>
          ) : (
            <>v{currentVersion}</>
          )}
        </span>
      </div>
    </Button>
  );
}

function FreeUserMessage() {
  return (
    <span>
      You are on a free plan!{' '}
      <Link to="/subscription" className="text-adam-blue hover:underline">
        Upgrade
      </Link>{' '}
      to a paid plan to experience all the features AzureFilm Generator has to
      offer.
    </span>
  );
}

function LimitReachedMessage() {
  return (
    <span>
      You have reached the limit of parametric generations in your current plan.{' '}
      <Link to="/subscription" className="text-adam-blue hover:underline">
        Upgrade
      </Link>{' '}
      for more parametric generations :)
    </span>
  );
}

function ImageLimitReachedMessage() {
  return (
    <span>
      You have reached the limit of image generations in your current plan.{' '}
      <Link to="/subscription" className="text-adam-blue hover:underline">
        Upgrade
      </Link>{' '}
      for more image generations :)
    </span>
  );
}

function InsufficientTokensMessage() {
  const { billing } = useAuth();
  const level = getLevel(billing);
  return (
    <span>
      You don't have enough tokens for this operation.{' '}
      <Link to="/settings" className="text-adam-blue hover:underline">
        Buy more tokens
      </Link>
      {level === 'free' && (
        <>
          {' '}
          or{' '}
          <Link to="/subscription" className="text-adam-blue hover:underline">
            upgrade your plan
          </Link>
        </>
      )}
      .
    </span>
  );
}

function MeshLimitReachedMessage() {
  const { billing } = useAuth();
  const level = getLevel(billing);
  if (level === 'free') {
    return (
      <span>
        You have reached the limit of 3 creative generations per day. Please
        upgrade to{' '}
        <Link to="/subscription" className="text-adam-blue hover:underline">
          a paid plan
        </Link>{' '}
        for more creative generations :)
      </span>
    );
  }

  if (level === 'standard') {
    return (
      <span>
        You have reached the limit of 100 creative generations per month. Please
        upgrade to{' '}
        <Link to="/subscription" className="text-adam-blue hover:underline">
          Pro
        </Link>{' '}
        for more creative generations :)
      </span>
    );
  }

  if (level === 'pro' || level === 'max') {
    return (
      <span>
        You have reached the limit of 1500 generations per month. Let us know if
        you need more!
      </span>
    );
  }
}

function AssistantMessageImagesViewer({ message }: { message: Message }) {
  const { currentMessage, setCurrentMessage } = useCurrentMessage();
  const isMobile = useIsMobile();

  if (!message.content.images) {
    return null;
  }

  return (
    <div
      className={cn(
        message.content.images.length > 1 && 'grid-cols-2',
        'grid gap-3',
      )}
    >
      {message.content.images.map((image: string, index: number) => (
        <div
          key={image}
          onClick={() => {
            if (
              currentMessage &&
              message.id === currentMessage?.id &&
              currentMessage?.content.index === index
            ) {
              setCurrentMessage(null);
            } else {
              setCurrentMessage({
                ...message,
                content: { ...message.content, index },
              });
            }
          }}
        >
          <ImageViewer
            className={cn(
              'aspect-square h-fit cursor-pointer',
              currentMessage?.id === message.id &&
                currentMessage?.content.index === index &&
                'outline outline-2 outline-adam-blue',
            )}
            image={image}
            clickable={!isMobile}
          />
        </div>
      ))}
    </div>
  );
}
