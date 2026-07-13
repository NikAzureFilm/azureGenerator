import { useConversation } from '@/contexts/ConversationContext';
import { getSupabaseFunctionUrl, supabase } from '@/lib/supabase';
import {
  Content,
  Conversation,
  Message,
  Model,
  normalizeCreativeModel,
} from '@shared/types';
import type { Json } from '@shared/database';
import { HistoryConversation } from '../types/misc.ts';
import {
  QueryClient,
  UseMutateAsyncFunction,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import * as Sentry from '@sentry/react';
import { normalizeParametricChatModel } from '@/lib/parametricModels';
import { shouldPollMessagesForGeneration } from '@/utils/generationStatus';
import { consumeMessageStream } from '@/services/messageStream';
import { driveParametricLoop } from '@/utils/parametricLoop';
import { isDrivableLoopMessage } from '@/utils/parametricLoopDecision';

function messageSentConversationUpdate(
  newMessage: Message,
  conversationId: string,
) {
  return (
    oldConversations: Conversation[] | HistoryConversation[] | undefined,
  ) => {
    if (!oldConversations) return oldConversations;
    return oldConversations
      .map((conv) => {
        if (conv.id === conversationId) {
          return {
            ...conv,
            current_message_leaf_id: newMessage.id,
            updated_at: newMessage.created_at,
          };
        }
        return conv;
      })
      .sort((a: Conversation, b: Conversation) => {
        return (
          new Date(b.updated_at ?? '').getTime() -
          new Date(a.updated_at ?? '').getTime()
        );
      });
  };
}

function messageInsertedConversationUpdate(
  queryClient: QueryClient,
  newMessage: Message,
  conversationId: string,
) {
  // Update the current conversation optimistically
  queryClient.setQueryData(
    ['conversation', conversationId],
    (oldConversation: Conversation) => ({
      ...oldConversation,
      current_message_leaf_id: newMessage.id,
    }),
  );

  // Update messages optimistically
  queryClient.setQueryData(
    ['messages', conversationId],
    (oldMessages: Message[] | undefined) => {
      if (!oldMessages || oldMessages.length === 0) return [newMessage];
      if (oldMessages.find((msg) => msg.id === newMessage.id)) {
        return oldMessages.map((msg) =>
          msg.id === newMessage.id ? newMessage : msg,
        );
      }
      return [...oldMessages, newMessage];
    },
  );

  // Update conversations list optimistically instead of invalidating
  queryClient.setQueryData(
    ['conversations'],
    messageSentConversationUpdate(newMessage, conversationId),
  );

  // Also update the recent conversations in sidebar
  queryClient.setQueryData(
    ['conversations', 'recent'],
    messageSentConversationUpdate(newMessage, conversationId),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function fetchGeneratedImagePrompts({
  imageIds,
  userId,
  conversationId,
  imageGenerationModel,
}: {
  imageIds: string[];
  userId: string;
  conversationId: string;
  imageGenerationModel?: unknown;
}): Promise<Map<string, Json>> {
  const uniqueIds = [...new Set(imageIds.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const objectKeys = uniqueIds.map((id) => `${userId}/${conversationId}/${id}`);
  const { data, error } = await supabase
    .from('generation_assets')
    .select('source_id,object_key,metadata')
    .eq('kind', 'image')
    .is('deleted_at', null)
    .in('object_key', objectKeys);

  if (error) return new Map();

  const idSet = new Set(uniqueIds);
  const prompts = new Map<string, Json>();
  for (const asset of data ?? []) {
    const metadata = (isRecord(asset.metadata) ? asset.metadata : {}) as Record<
      string,
      Json | undefined
    >;
    if (metadata.source !== 'generate-view') continue;

    const sourceId =
      typeof asset.source_id === 'string' && idSet.has(asset.source_id)
        ? asset.source_id
        : null;
    const objectId =
      typeof asset.object_key === 'string'
        ? asset.object_key.split('/').filter(Boolean).at(-1)
        : null;
    const id = sourceId ?? (objectId && idSet.has(objectId) ? objectId : null);
    if (!id) continue;

    const view = stringValue(metadata.view);
    const mode = stringValue(metadata.mode);
    const label =
      mode === 'multiview' && view
        ? `${view} view image`
        : mode === 'input'
          ? 'input image'
          : 'image';

    const selectedModel = stringValue(imageGenerationModel);
    prompts.set(id, {
      ...metadata,
      generated: true,
      source: 'generate-view',
      text: `Generated ${label}`,
      ...(selectedModel ? { imageGenerationModel: selectedModel } : {}),
    });
  }

  return prompts;
}

export const useMessagesQuery = () => {
  const { conversation } = useConversation();
  return useQuery<Message[]>({
    enabled: !!conversation.id,
    queryKey: ['messages', conversation.id],
    initialData: [],
    queryFn: async () => {
      const { data: messagesData, error: messagesError } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversation.id)
        .order('created_at', { ascending: true })
        .overrideTypes<
          Array<{ content: Content; role: 'user' | 'assistant' }>
        >();

      if (messagesError) throw messagesError;

      return messagesData || [];
    },
    refetchInterval: (query) => {
      const messages = query.state.data as Message[] | undefined;
      return shouldPollMessagesForGeneration(messages) ? 3000 : false;
    },
  });
};

export function useInsertMessageMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      message: Omit<Message, 'id' | 'created_at' | 'rating'>,
    ) => {
      const { data, error } = await supabase
        .from('messages')
        .insert([{ ...message }])
        .select()
        .single()
        .overrideTypes<{ content: Content; role: 'user' | 'assistant' }>();

      if (error) throw error;

      return data;
    },
    onSuccess(newMessage) {
      messageInsertedConversationUpdate(
        queryClient,
        newMessage,
        newMessage.conversation_id,
      );
    },
    onError(error, message) {
      Sentry.captureException(error, {
        extra: {
          hook: 'useInsertMessageMutation',
          message,
        },
      });
    },
  });
}
export function useCreativeChatMutation({
  conversationId,
}: {
  conversationId: string;
}) {
  const queryClient = useQueryClient();
  const { mutateAsync: insertMessageAsync } = useInsertMessageMutation();

  return useMutation({
    mutationKey: ['creative-chat', conversationId],
    mutationFn: async ({
      model,
      messageId,
      conversationId,
    }: {
      model: Model;
      messageId: string;
      conversationId: string;
    }) => {
      const newMessageId = crypto.randomUUID();
      let initialized = false;

      // Start streaming request
      const response = await fetch(getSupabaseFunctionUrl('creative-chat'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${
            (await supabase.auth.getSession()).data.session?.access_token
          }`,
        },
        body: JSON.stringify({
          conversationId,
          messageId,
          model,
          newMessageId,
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Network response was not ok: ${response.status} ${response.statusText}`,
        );
      }

      if (response.headers.get('Content-Type')?.includes('application/json')) {
        const data = await response.json();
        if (data.message) {
          return data.message;
        } else {
          throw new Error('No message received');
        }
      }

      async function initialize() {
        // Cancel any pending queries and update conversation leaf ID
        await queryClient.cancelQueries({
          queryKey: ['conversation', conversationId],
        });
        queryClient.setQueryData(
          ['conversation', conversationId],
          (oldConversation: Conversation) => ({
            ...oldConversation,
            current_message_leaf_id: newMessageId,
          }),
        );
      }

      const finalMessage = await consumeMessageStream({
        response,
        queryClient,
        conversationId,
        onFirstMessage: async () => {
          if (!initialized) {
            await initialize();
            initialized = true;
          }
        },
      });

      if (!finalMessage) {
        throw new Error('No final message received');
      }

      return finalMessage;
    },
    onSuccess: (newMessage) => {
      messageInsertedConversationUpdate(
        queryClient,
        newMessage,
        conversationId,
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['userExtraData'] });
    },
    onError: async (error, { messageId }) => {
      Sentry.captureException(error, {
        extra: {
          hook: 'useCreativeChatMutation',
          messageId,
          conversationId,
        },
      });
      // Since abort is handled in the function, we need to handle all other errors here by adding a new message
      try {
        await insertMessageAsync({
          role: 'assistant',
          content: {
            text: 'An error occurred while processing your request.',
          },
          parent_message_id: messageId,
          conversation_id: conversationId,
        });
      } catch (error) {
        Sentry.captureException(error, {
          extra: {
            hook: 'useCreativeChatMutation insertMessageAsync',
            messageId,
            conversationId,
          },
        });
      }
    },
  });
}
export function useAgentChatMutation({
  conversationId,
}: {
  conversationId: string;
}) {
  const queryClient = useQueryClient();
  const { mutateAsync: insertMessageAsync } = useInsertMessageMutation();

  return useMutation({
    mutationKey: ['agent-chat', conversationId],
    mutationFn: async ({
      messageId,
      conversationId,
    }: {
      messageId: string;
      conversationId: string;
    }) => {
      const newMessageId = crypto.randomUUID();
      let initialized = false;

      // Start streaming request
      const response = await fetch(getSupabaseFunctionUrl('agent-chat'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${
            (await supabase.auth.getSession()).data.session?.access_token
          }`,
        },
        body: JSON.stringify({
          conversationId,
          messageId,
          newMessageId,
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Network response was not ok: ${response.status} ${response.statusText}`,
        );
      }

      if (response.headers.get('Content-Type')?.includes('application/json')) {
        const data = await response.json();
        if (data.message) {
          return data.message;
        } else {
          throw new Error('No message received');
        }
      }

      async function initialize() {
        await queryClient.cancelQueries({
          queryKey: ['conversation', conversationId],
        });
        queryClient.setQueryData(
          ['conversation', conversationId],
          (oldConversation: Conversation) => ({
            ...oldConversation,
            current_message_leaf_id: newMessageId,
          }),
        );
      }

      const finalMessage = await consumeMessageStream({
        response,
        queryClient,
        conversationId,
        onFirstMessage: async () => {
          if (!initialized) {
            await initialize();
            initialized = true;
          }
        },
      });

      if (!finalMessage) {
        throw new Error('No final message received');
      }

      return finalMessage;
    },
    onSuccess: (newMessage) => {
      messageInsertedConversationUpdate(
        queryClient,
        newMessage,
        conversationId,
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['userExtraData'] });
    },
    onError: async (error, { messageId }) => {
      Sentry.captureException(error, {
        extra: {
          hook: 'useAgentChatMutation',
          messageId,
          conversationId,
        },
      });
      try {
        await insertMessageAsync({
          role: 'assistant',
          content: {
            text: 'An error occurred while processing your request.',
          },
          parent_message_id: messageId,
          conversation_id: conversationId,
        });
      } catch (error) {
        Sentry.captureException(error, {
          extra: {
            hook: 'useAgentChatMutation insertMessageAsync',
            messageId,
            conversationId,
          },
        });
      }
    },
  });
}

export function useParametricChatMutation({
  conversationId,
}: {
  conversationId: string;
}) {
  const queryClient = useQueryClient();
  const { mutateAsync: insertMessageAsync } = useInsertMessageMutation();

  return useMutation({
    mutationKey: ['parametric-chat', conversationId],
    mutationFn: async ({
      model,
      messageId,
      conversationId,
    }: {
      model: Model;
      messageId: string;
      conversationId: string;
    }) => {
      const newMessageId = crypto.randomUUID();
      let initialized = false;

      // Start streaming request
      const response = await fetch(getSupabaseFunctionUrl('parametric-chat'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${
            (await supabase.auth.getSession()).data.session?.access_token
          }`,
        },
        body: JSON.stringify({
          conversationId,
          messageId,
          model,
          newMessageId,
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Network response was not ok: ${response.status} ${response.statusText}`,
        );
      }

      if (response.headers.get('Content-Type')?.includes('application/json')) {
        const data = await response.json();
        if (data.message) {
          return data.message;
        } else {
          throw new Error('No message received');
        }
      }

      async function initialize() {
        // Cancel any pending queries and update conversation leaf ID
        await queryClient.cancelQueries({
          queryKey: ['conversation', conversationId],
        });
        queryClient.setQueryData(
          ['conversation', conversationId],
          (oldConversation: Conversation) => ({
            ...oldConversation,
            current_message_leaf_id: newMessageId,
          }),
        );
      }

      const finalMessage = await consumeMessageStream({
        response,
        queryClient,
        conversationId,
        onFirstMessage: async () => {
          if (!initialized) {
            await initialize();
            initialized = true;
          }
        },
      });

      if (!finalMessage) {
        throw new Error('No final message received');
      }

      // Round 0 is done. If the server left the message awaiting a client
      // continuation, drive the agentic loop (compile auto-repair + premium
      // visual inspection) in the background — do NOT await it, so the
      // mutation resolves and isLoading clears while later rounds stream into
      // the cache through the same reader.
      if (isDrivableLoopMessage(finalMessage)) {
        void driveParametricLoop({
          message: finalMessage,
          queryClient,
          conversationId,
        });
      }

      return finalMessage;
    },
    onSuccess: (newMessage) => {
      messageInsertedConversationUpdate(
        queryClient,
        newMessage,
        conversationId,
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['userExtraData'] });
    },
    onError: async (error, { messageId }) => {
      Sentry.captureException(error, {
        extra: {
          hook: 'useParametricChatMutation',
          messageId,
          conversationId,
        },
      });
      try {
        await insertMessageAsync({
          role: 'assistant',
          content: {
            text: 'An error occurred while processing your request.',
          },
          parent_message_id: messageId,
          conversation_id: conversationId,
        });
      } catch (error) {
        Sentry.captureException(error, {
          extra: {
            hook: 'useParametricChatMutation insertMessageAsync',
            messageId,
            conversationId,
          },
        });
      }
    },
  });
}

export function useSendContentMutation({
  conversation,
}: {
  conversation: Pick<
    Conversation,
    'id' | 'user_id' | 'settings' | 'current_message_leaf_id' | 'type'
  >;
}) {
  const queryClient = useQueryClient();
  const { mutateAsync: insertMessageAsync } = useInsertMessageMutation();
  const { mutateAsync: sendToCreativeChat } = useCreativeChatMutation({
    conversationId: conversation.id,
  });

  const { mutateAsync: sendToParametricChat } = useParametricChatMutation({
    conversationId: conversation.id,
  });

  const { mutateAsync: sendToAgentChat } = useAgentChatMutation({
    conversationId: conversation.id,
  });

  return useMutation({
    mutationKey: ['send-content', conversation.id],
    mutationFn: async (content: Content) => {
      // Handle image uploads and create message
      const databaseOperations = [];

      if (content.images && content.images.length > 0) {
        const generatedImagePrompts = await fetchGeneratedImagePrompts({
          imageIds: content.images,
          userId: conversation.user_id,
          conversationId: conversation.id,
          imageGenerationModel: content.imageGenerationModel,
        });
        // Create database entries for images and move them to conversation folder
        const imageOperations = content.images.map(async (imageId) => {
          // Create the image record in the database
          const { error: imageError } = await supabase.from('images').upsert(
            {
              id: imageId,
              prompt: generatedImagePrompts.get(imageId) ?? {
                text: 'User uploaded image',
              },
              status: 'success',
              user_id: conversation.user_id,
              conversation_id: conversation.id,
            },
            {
              onConflict: 'id',
              ignoreDuplicates: true,
            },
          );

          if (imageError) throw imageError;
        });
        databaseOperations.push(...imageOperations);
      }

      if (content.mesh) {
        const meshOperation = supabase
          .from('meshes')
          .upsert(
            {
              id: content.mesh.id,
              conversation_id: conversation.id,
              user_id: conversation.user_id,
              status: 'success',
              prompt: {
                text: 'User uploaded mesh',
              },
              file_type: content.mesh.fileType,
            },
            {
              onConflict: 'id',
              ignoreDuplicates: true,
            },
          )
          .then(({ error: meshError }) => {
            if (meshError) throw meshError;
          });

        databaseOperations.push(meshOperation);
      }

      await Promise.all(databaseOperations);

      const userMessage = await insertMessageAsync({
        role: 'user',
        content,
        parent_message_id: conversation.current_message_leaf_id ?? null,
        conversation_id: conversation.id,
      });

      if (conversation.settings?.mode === 'agent') {
        await sendToAgentChat({
          messageId: userMessage.id,
          conversationId: conversation.id,
        });
      } else if (conversation.type === 'creative') {
        await sendToCreativeChat({
          model: normalizeCreativeModel(
            content.model ?? conversation.settings?.model,
          ),
          messageId: userMessage.id,
          conversationId: conversation.id,
        });
      } else {
        await sendToParametricChat({
          model: normalizeParametricChatModel(
            content.model ?? conversation.settings?.model,
          ),
          messageId: userMessage.id,
          conversationId: conversation.id,
        });
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['billing', 'status'] });
    },
  });
}

export function useUpdateMessageOptimisticMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ message }: { message: Message }) => {
      const { data: updatedMessage, error: messageError } = await supabase
        .from('messages')
        .update({
          // only content and rating get updated
          content: message.content,
          rating: message.rating,
        })
        .eq('id', message.id)
        .eq('conversation_id', message.conversation_id)
        .select()
        .single();

      if (messageError) throw messageError;

      return updatedMessage as Message;
    },
    onMutate: async ({ message }) => {
      await queryClient.cancelQueries({
        queryKey: ['messages', message.conversation_id],
      });
      const oldMessages = queryClient.getQueryData<Message[]>([
        'messages',
        message.conversation_id,
      ]);
      queryClient.setQueryData(
        ['messages', message.conversation_id],
        oldMessages?.map((msg) =>
          msg.id === message.id ? { ...msg, ...message } : msg,
        ),
      );
      return { oldMessages };
    },
    onSettled(_data, _error, { message }) {
      queryClient.invalidateQueries({
        queryKey: ['messages', message.conversation_id],
      });
    },
    onError(error, { message }, context) {
      Sentry.captureException(error, {
        extra: {
          hook: 'useUpdateMessageOptimisticMutation',
          message,
        },
      });
      queryClient.setQueryData(
        ['messages', message.conversation_id],
        context?.oldMessages,
      );
    },
  });
}

export function useEditMessageMutation({
  conversation,
}: {
  conversation: Conversation;
}) {
  const { mutateAsync: insertMessageAsync } = useInsertMessageMutation();

  const { mutateAsync: sendToCreativeChat } = useCreativeChatMutation({
    conversationId: conversation.id,
  });

  const { mutateAsync: sendToParametricChat } = useParametricChatMutation({
    conversationId: conversation.id,
  });

  return useMutation({
    mutationKey: ['edit-message', conversation.id],
    mutationFn: async (updatedMessage: Message) => {
      const userMessage = await insertMessageAsync({
        role: updatedMessage.role,
        content: updatedMessage.content,
        parent_message_id: updatedMessage.parent_message_id ?? null,
        conversation_id: conversation.id,
      });

      if (conversation.type === 'creative') {
        sendToCreativeChat({
          model: normalizeCreativeModel(conversation.settings?.model),
          messageId: userMessage.id,
          conversationId: conversation.id,
        });
      } else {
        sendToParametricChat({
          model: normalizeParametricChatModel(conversation.settings?.model),
          messageId: userMessage.id,
          conversationId: conversation.id,
        });
      }
    },
    onError: (error, updatedMessage) => {
      Sentry.captureException(error, {
        extra: {
          hook: 'useEditMessageMutation',
          updatedMessage,
          conversationId: conversation.id,
        },
      });
    },
  });
}

export function useRetryMessageMutation({
  conversation,
  updateConversationAsync,
}: {
  conversation: Conversation;
  updateConversationAsync?: UseMutateAsyncFunction<
    Conversation,
    Error,
    Conversation
  >;
}) {
  const { mutateAsync: sendToCreativeChat } = useCreativeChatMutation({
    conversationId: conversation.id,
  });

  const { mutateAsync: sendToParametricChat } = useParametricChatMutation({
    conversationId: conversation.id,
  });

  return useMutation({
    mutationKey: ['retry-message', conversation.id],
    mutationFn: async ({ model, id }: { model: Model; id: string }) => {
      if (!updateConversationAsync) {
        throw new Error('Cannot update conversation');
      }
      const runtimeModel =
        conversation.type === 'parametric'
          ? normalizeParametricChatModel(model)
          : normalizeCreativeModel(model);

      await updateConversationAsync({
        ...conversation,
        settings: {
          ...(typeof conversation.settings === 'object'
            ? conversation.settings
            : {}),
          model: runtimeModel,
        },
        current_message_leaf_id: id,
      });

      if (conversation.type === 'creative') {
        sendToCreativeChat({
          model: runtimeModel,
          messageId: id,
          conversationId: conversation.id,
        });
      } else {
        sendToParametricChat({
          model: runtimeModel,
          messageId: id,
          conversationId: conversation.id,
        });
      }
    },
    onError: (error, { model, id }) => {
      Sentry.captureException(error, {
        extra: {
          hook: 'useRetryMessageMutation',
          conversationId: conversation.id,
          model,
          id,
        },
      });
    },
  });
}

export function useRestoreMessageMutation() {
  const { mutateAsync: insertMessageAsync } = useInsertMessageMutation();

  return useMutation({
    mutationFn: async (messageToRestore: Message) => {
      await insertMessageAsync({
        role: messageToRestore.role,
        content: messageToRestore.content,
        parent_message_id: messageToRestore.parent_message_id ?? null,
        conversation_id: messageToRestore.conversation_id,
      });
    },
    onError: (error, messageToRestore) => {
      Sentry.captureException(error, {
        extra: {
          hook: 'useRestoreMessageMutation',
          messageToRestore,
        },
      });
    },
  });
}

export function useChangeRatingMutation({
  conversationId,
}: {
  conversationId: string;
}) {
  const queryClient = useQueryClient();
  const { mutateAsync: updateMessageOptimistic } =
    useUpdateMessageOptimisticMutation();

  const messages = queryClient.getQueryData<Message[]>([
    'messages',
    conversationId,
  ]);

  return useMutation({
    mutationKey: ['change-rating', conversationId],
    mutationFn: async ({
      messageId,
      rating,
    }: {
      messageId: string;
      rating: number;
    }) => {
      const oldMessage = messages?.find((msg) => msg.id === messageId);
      if (!oldMessage) return;
      updateMessageOptimistic({ message: { ...oldMessage, rating } });
    },
  });
}

export function useUpscaleMutation({
  conversation,
  updateConversationAsync,
}: {
  conversation: Conversation;
  updateConversationAsync?: (conversation: Conversation) => Promise<unknown>;
}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ['upscale', conversation.id],
    mutationFn: async ({
      meshId,
      parentMessageId,
    }: {
      meshId: string;
      parentMessageId: string | null;
    }) => {
      // Immediately navigate to parent message to show loading state
      if (parentMessageId && updateConversationAsync) {
        await updateConversationAsync({
          ...conversation,
          current_message_leaf_id: parentMessageId,
        });
      }

      const response = await fetch(getSupabaseFunctionUrl('mesh'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${
            (await supabase.auth.getSession()).data.session?.access_token
          }`,
        },
        body: JSON.stringify({
          action: 'upscale',
          meshId,
          conversationId: conversation.id,
          parentMessageId,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to upscale');
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No reader available');
      }

      const decoder = new TextDecoder();
      let leftover = '';
      let finalMessage: Message | null = null;
      let initialized = false;

      async function initialize(messageId: string) {
        await queryClient.cancelQueries({
          queryKey: ['conversation', conversation.id],
        });
        queryClient.setQueryData(
          ['conversation', conversation.id],
          (oldConversation: Conversation) => ({
            ...oldConversation,
            current_message_leaf_id: messageId,
          }),
        );
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        leftover += decoder.decode(value, { stream: true });
        const lines = leftover.split('\n');
        leftover = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          try {
            const data: Message = JSON.parse(line);
            finalMessage = data;

            queryClient.setQueryData(
              ['messages', conversation.id],
              (oldMessages: Message[] | undefined) => {
                if (!oldMessages || oldMessages.length === 0) {
                  return [data];
                }
                if (oldMessages.find((msg) => msg.id === data.id)) {
                  return oldMessages.map((msg) =>
                    msg.id === data.id ? data : msg,
                  );
                } else {
                  return [...oldMessages, data];
                }
              },
            );

            if (!initialized && data.id) {
              await initialize(data.id);
              initialized = true;
            }
          } catch (parseError) {
            console.error('Error parsing streaming data:', parseError);
          }
        }
      }

      // Process remaining data
      const tail = leftover.trim();
      if (tail) {
        try {
          const data: Message = JSON.parse(tail);
          finalMessage = data;
          queryClient.setQueryData(
            ['messages', conversation.id],
            (oldMessages: Message[] | undefined) => {
              if (!oldMessages || oldMessages.length === 0) {
                return [data];
              }
              if (oldMessages.find((msg) => msg.id === data.id)) {
                return oldMessages.map((msg) =>
                  msg.id === data.id ? data : msg,
                );
              } else {
                return [...oldMessages, data];
              }
            },
          );
        } catch (parseError) {
          console.error('Error parsing final streaming data:', parseError);
        }
      }

      reader.releaseLock();
      return finalMessage;
    },
    onError: (error) => {
      Sentry.captureException(error, {
        extra: {
          hook: 'useUpscaleMutation',
          conversationId: conversation.id,
        },
      });
    },
  });
}
