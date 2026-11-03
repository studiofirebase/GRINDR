import { createContext } from "svelte";
import { toast } from "svelte-sonner";

import { accountScoped } from "$lib/api/account-caches";
import { maybeSendAutomaticReply } from "$lib/chat/automatic-replies";
import { showIncomingMessageToast } from "$lib/components/incoming-message-toast/incoming-message-toast-manager";
import { announceMessage } from "$lib/push/announce";
import {
	withdrawChatNotification,
	withdrawShownReadChats,
} from "$lib/push/chat-withdrawals";
import { ConversationsState } from "./conversations-state.svelte";

export const [getConversations, setConversations] =
	createContext<ConversationsState>();

export const getOrCreateConversationsState = accountScoped(
	(profileId) =>
		new ConversationsState({
			ourProfileId: profileId,
			onAutomaticReply: (message) =>
				void maybeSendAutomaticReply({
					message,
					ourProfileId: profileId,
				}),
			onIncomingMessage: ({ message, conversation, inView }) => {
				announceMessage({ message, sender: conversation.data.name });
				if (inView) return;
				showIncomingMessageToast({
					message,
					sender: {
						name: conversation.data.name,
						avatarMediaHash:
							conversation.data.participants[0]
								?.primaryMediaHash ?? null,
					},
					conversationId: conversation.data.conversationId,
				});
			},
			onConversationRead: (conversationId) => {
				// The balloon served its purpose once the chat is opened:
				// with a persistent duration it would otherwise linger.
				toast.dismiss(conversationId);
				withdrawChatNotification({ conversationId });
			},
			onFetchedReads: (conversationIds) =>
				void withdrawShownReadChats(conversationIds),
		}),
);
