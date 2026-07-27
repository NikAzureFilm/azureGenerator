import { useNavigate, Link } from '@tanstack/react-router';
import { ArrowUpRight, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import TextAreaChat from '@/components/TextAreaChat';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import {
  Content,
  Conversation,
  DEFAULT_CREATIVE_MODEL,
  Model,
  MultiviewImages,
} from '@shared/types';
import { MessageItem } from '../types/misc.ts';
import { LimitReachedMessage } from '@/components/LimitReachedMessage';
import { LowPromptsWarningMessage } from '@/components/LowPromptsWarningMessage';
import { useIsMobile } from '@/hooks/useIsMobile';
import { cn } from '@/lib/utils';
import { SelectedItemsContext } from '@/contexts/SelectedItemsContext';
import posthog from 'posthog-js';
import * as Sentry from '@sentry/react';
import { useSendContentMutation } from '@/services/messageService';
import { useProfile } from '@/services/profileService';
import { BrandLogo } from '@/components/BrandLogo';
import { AgentComposer } from '@/components/AgentComposer';
import { CreationModeCards } from '@/components/CreationModeCards';
import type { CreationModeType } from '@/utils/creationModeOptions';
import {
  DEFAULT_IMAGE_GENERATION_MODEL,
  type ImageGenerationModel,
} from '@shared/imageGeneration';
import { DEFAULT_PARAMETRIC_MODEL } from '@/lib/parametricModels';
import { useLayoutContext } from '@/contexts/LayoutContext';

const PROMO_PILLS = [
  {
    href: 'https://azurefilm.com/',
    event: 'azurefilm_banner_click',
    prefix: 'Need filament for your print?',
    label: 'Shop AzureFilm',
  },
] as const;

export function PromptView() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, billing, isLoading } = useAuth();
  const totalTokens = billing?.tokens.total ?? 0;
  const { data: profile, isLoading: isProfileLoading } = useProfile();
  const { isSidebarOpen } = useLayoutContext();
  const queryClient = useQueryClient();

  const firstName = useMemo(() => {
    // Wait until the profile query resolves for signed-in users so the
    // greeting doesn't flash the email local-part before snapping to the
    // real first name.
    if (user && isProfileLoading) return '';
    const source = profile?.full_name || user?.email?.split('@')[0] || '';
    return source.trim().split(/\s+/)[0] || '';
  }, [profile?.full_name, user, isProfileLoading]);

  const [type, setType] = useState<CreationModeType>('parametric');
  // Agent conversations live in the DB as 'creative' rows flagged with
  // settings.mode = 'agent' (no conversation-type enum migration needed).
  const conversationType = type === 'agent' ? 'creative' : type;

  const [model, setModel] = useState<Model>(DEFAULT_PARAMETRIC_MODEL);
  const [imageGenerationModel, setImageGenerationModel] =
    useState<ImageGenerationModel>(DEFAULT_IMAGE_GENERATION_MODEL);

  const handleTypeChange = (newType: CreationModeType) => {
    setType(newType);
    // Reset model to the default for the new type
    if (newType === 'creative') {
      setModel(DEFAULT_CREATIVE_MODEL);
    } else {
      setModel(DEFAULT_PARAMETRIC_MODEL);
    }
  };

  const [isLoaded, setIsLoaded] = useState(false);
  const isMobile = useIsMobile();
  const [images, setImages] = useState<MessageItem[]>([]);
  const [mesh, setMesh] = useState<MessageItem | null>(null);

  const newConversationId = useMemo(() => {
    return crypto.randomUUID();
  }, []);

  const lowPrompts = useMemo(() => {
    if (isLoading) return false;
    return totalTokens > 0 && totalTokens <= 10;
  }, [totalTokens, isLoading]);

  const limitReached = useMemo(() => {
    if (isLoading) return false;
    return totalTokens <= 0;
  }, [totalTokens, isLoading]);

  const { mutate: sendMessage } = useSendContentMutation({
    conversation: {
      id: newConversationId,
      user_id: user?.id ?? '',
      type: conversationType,
      settings: {
        model: model,
        imageGenerationModel,
        ...(type === 'agent' ? { mode: 'agent' as const } : {}),
      },
      current_message_leaf_id: null,
    },
  });

  // Multiview views generated before submit are kept on the draft
  // conversation's settings so a reload can rehydrate them.
  const multiviewDraftImagesRef = useRef<MultiviewImages | null>(null);

  const ensureConversation = useCallback(async () => {
    if (!user?.id) {
      throw new Error('Sign in to generate an input image');
    }

    const multiviewImages = multiviewDraftImagesRef.current;
    const { error } = await supabase.from('conversations').upsert(
      {
        id: newConversationId,
        user_id: user.id,
        title: 'New Conversation',
        type: conversationType,
        settings: {
          model,
          imageGenerationModel,
          ...(multiviewImages?.front ? { multiviewImages } : {}),
          ...(type === 'agent' ? { mode: 'agent' } : {}),
        },
      },
      { onConflict: 'id' },
    );

    if (error) throw error;
  }, [
    conversationType,
    imageGenerationModel,
    model,
    newConversationId,
    type,
    user?.id,
  ]);

  const persistMultiviewDraft = useCallback(
    async (images: MultiviewImages) => {
      multiviewDraftImagesRef.current = images;
      await ensureConversation();
    },
    [ensureConversation],
  );

  // Trigger fade in on mount
  useEffect(() => {
    // Use requestAnimationFrame to ensure the initial render is complete
    const frame = requestAnimationFrame(() => {
      setIsLoaded(true);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // Helper function to get time-based greeting (memoized for performance)
  const getTimeBasedGreeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) {
      return 'Good morning';
    } else if (hour < 18) {
      return 'Good afternoon';
    } else {
      return 'Good evening';
    }
  }, []); // Empty dependency array means it only calculates once per page load

  const { mutate: handleGenerate } = useMutation({
    mutationFn: async (content: Content) => {
      posthog.capture('new_conversation', {
        type: type,
        model_name: model,
        text: (content.text ?? '').trim().slice(0, 100),
        image_count: content.images?.length ?? 0,
        mesh_count: content.mesh ? 1 : 0,
        conversation_id: newConversationId,
      });

      await ensureConversation();

      sendMessage(content);

      return {
        conversationId: newConversationId,
        content: content,
      };
    },
    onSuccess: (data) => {
      // Generate title in the background if there's content
      supabase.functions
        .invoke('title-generator', {
          body: { content: data.content, conversationId: data.conversationId },
        })
        .then(({ data: titleData, error }) => {
          if (!error && titleData?.title) {
            // Update conversation title once generated
            supabase
              .from('conversations')
              .update({ title: titleData.title })
              .eq('id', data.conversationId)
              .then(() => {
                queryClient.invalidateQueries({
                  queryKey: ['conversations'],
                });

                queryClient.setQueryData(
                  ['conversation', data.conversationId],
                  (oldConversation: Conversation) => ({
                    ...oldConversation,
                    title: titleData.title,
                  }),
                );
              });
          }
        })
        .catch((error) => {
          console.error('Error generating title:', error);
        });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      navigate({ to: '/editor/$id', params: { id: data.conversationId } });
    },
    onError: (error) => {
      Sentry.captureException(error);
      toast({
        title: 'Error',
        description:
          error instanceof Error ? error.message : 'Failed to process prompt',
        variant: 'destructive',
      });
    },
  });

  return (
    <div
      className={cn(
        'relative h-full min-h-full w-full transition-all duration-300 ease-in-out',
        isSidebarOpen && !isMobile && user?.id && 'pb-6 pr-6 pt-6',
      )}
    >
      <div
        className={cn(
          'h-full min-h-full bg-adam-bg-secondary-dark',
          isSidebarOpen &&
            !isMobile &&
            user?.id &&
            'rounded-xl shadow-[0_0_15px_rgba(0,0,0,0.1)]',
        )}
      >
        {!user && (
          <div className="fixed right-4 top-4 z-10 flex flex-row gap-2">
            <Button
              variant="light"
              onClick={() => navigate({ to: '/signup' })}
              className="w-auto"
            >
              Sign Up
            </Button>
            <Button
              onClick={() => navigate({ to: '/signin' })}
              className="w-auto"
            >
              <LogIn className="mr-2 h-4 w-4" />
              Sign In
            </Button>
          </div>
        )}

        <main
          className={cn(
            'flex h-full w-full flex-col items-center overflow-y-auto px-4 pb-4 md:px-8',
            user
              ? 'justify-start pt-8 desktop:justify-center'
              : 'justify-start pt-20 desktop:justify-center desktop:py-8',
          )}
        >
          <div className="mx-auto flex max-w-3xl flex-col items-center justify-center">
            <BrandLogo
              variant="wordmark"
              className={cn(
                'mb-4 h-10 w-44 md:h-12 md:w-52',
                'motion-safe:transition-opacity motion-safe:duration-1000 motion-safe:ease-out',
                isLoaded ? 'opacity-100' : 'opacity-0',
              )}
            />
            <h1
              className={cn(
                'mb-8 text-center text-2xl font-medium text-adam-text-primary md:text-3xl lg:text-4xl',
                'motion-safe:transition-opacity motion-safe:duration-1000 motion-safe:ease-out',
                isLoaded ? 'opacity-100' : 'opacity-0',
              )}
            >
              {getTimeBasedGreeting}
              {firstName ? `, ${firstName}` : ''}!
            </h1>
          </div>
          <div
            className={cn(
              'mb-8 w-full max-w-[64rem]',
              'motion-safe:transition-opacity motion-safe:duration-700 motion-safe:ease-out',
              isLoaded ? 'opacity-100' : 'opacity-0',
            )}
          >
            <CreationModeCards
              selectedType={type}
              onTypeChange={handleTypeChange}
            />
          </div>
          <div className="flex w-full flex-col items-center">
            <div className="w-full max-w-3xl space-y-3 pb-2">
              <SelectedItemsContext.Provider
                value={{ images, setImages, mesh, setMesh }}
              >
                {type === 'agent' ? (
                  <AgentComposer
                    onSubmit={handleGenerate}
                    conversation={{
                      id: newConversationId,
                      user_id: user?.id ?? '',
                    }}
                    disabled={limitReached}
                    onFocus={() => {
                      if (!user) {
                        navigate({ to: '/signin' });
                        return;
                      }
                    }}
                    placeholder="Describe what you want to build — the agent will sketch it with you..."
                  />
                ) : (
                  <TextAreaChat
                    onSubmit={handleGenerate}
                    conversation={{
                      id: newConversationId,
                      user_id: user?.id ?? '',
                    }}
                    onFocus={() => {
                      if (!user) {
                        navigate({ to: '/signin' });
                        return;
                      }
                    }}
                    placeholder="Start building with AzureFilm Generator..."
                    type={type}
                    disabled={limitReached}
                    model={model}
                    setModel={setModel}
                    imageGenerationModel={imageGenerationModel}
                    setImageGenerationModel={setImageGenerationModel}
                    showPromptGenerator={true}
                    showFullLabels={true}
                    onTypeChange={handleTypeChange}
                    ensureConversation={ensureConversation}
                    persistMultiviewDraft={persistMultiviewDraft}
                  />
                )}
              </SelectedItemsContext.Provider>
              <div className="relative">
                {isLoading && (
                  <div className="absolute left-0 right-0 top-0">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-adam-blue border-t-transparent" />
                  </div>
                )}
                {!isLoading && user && limitReached && (
                  <div className="absolute left-0 right-0 top-0">
                    <LimitReachedMessage />
                  </div>
                )}
                {!isLoading && user && lowPrompts && !limitReached && (
                  <div className="absolute left-0 right-0 top-0">
                    <LowPromptsWarningMessage tokensRemaining={totalTokens} />
                  </div>
                )}
              </div>
              {!isLoading && user && !limitReached && !lowPrompts && (
                <div className="flex flex-wrap justify-center gap-2">
                  {PROMO_PILLS.map(({ href, event, prefix, label }) => (
                    <a
                      key={event}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => {
                        try {
                          posthog.capture(event, { location: 'prompt_view' });
                        } catch {
                          // Analytics failures (e.g. blocked by ad-blocker)
                          // must never block the link's navigation.
                        }
                      }}
                      className="group inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm text-adam-text-secondary transition-colors hover:border-adam-blue/40 hover:bg-adam-blue/10 hover:text-adam-text-primary"
                    >
                      <span>
                        {prefix}{' '}
                        <span className="font-medium text-adam-blue">
                          {label}
                        </span>
                      </span>
                      <ArrowUpRight className="h-3.5 w-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                    </a>
                  ))}
                </div>
              )}
              {!user && (
                <p className="text-center text-sm text-gray-500">
                  <Link
                    to="/signin"
                    className="!text-adam-blue hover:!text-adam-blue/80"
                  >
                    Sign in
                  </Link>{' '}
                  or{' '}
                  <Link
                    to="/signup"
                    className="!text-adam-blue hover:!text-adam-blue/80"
                  >
                    create an account
                  </Link>{' '}
                  to start generating
                </p>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
