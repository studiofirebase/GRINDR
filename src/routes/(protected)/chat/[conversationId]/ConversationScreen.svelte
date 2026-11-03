<script lang="ts">
	import { untrack } from "svelte";

	import { getAutomaticReplySettings } from "$lib/app-data/preferences.svelte";
	import { canSuggestAiReply, suggestAiReply } from "$lib/chat/ai-reply";
	import { getConversations } from "$lib/chat/conversations-context.svelte";
	import * as Card from "$lib/components/ui/card";
	import { setScreenLeaving } from "$lib/platform/back-gesture-event.svelte";
	import type { MessageDraft } from "$lib/model/messaging/messages";
	import ChatNavBar from "./conversation-nav-bar/ConversationNavBar.svelte";
	import {
		ConversationState,
		setConversationState,
	} from "./conversation-state.svelte";
	import MessageComposer from "./message-composer/MessageComposer.svelte";
	import ConversationMessages from "./messages/ConversationMessages.svelte";

	let {
		conversationId,
		ourProfileId,
		leaving = false,
	}: {
		conversationId: string;
		ourProfileId: number;
		leaving?: boolean;
	} = $props();

	setScreenLeaving(() => leaving);

	const conversations = getConversations();

	let conversationState = $state(
		untrack(
			() =>
				new ConversationState({
					conversationId,
					ourProfileId,
					conversations,
				}),
		),
	);

	$effect(() => {
		const id = conversationId;
		const profileId = ourProfileId;
		if (leaving) return;

		const state = untrack(() => {
			if (
				id !== conversationState.conversationId ||
				profileId !== conversationState.ourProfileId ||
				conversationState.destroyed
			) {
				const next = new ConversationState({
					conversationId: id,
					ourProfileId: profileId,
					conversations,
				});
				conversationState = next;
				return next;
			}
			return conversationState;
		});

		return () => state.destroy();
	});

	setConversationState(() => conversationState);

	let composerHeight = $state(0);
	const canSuggestReply = $derived(
		canSuggestAiReply(
			conversationState.messages,
			conversationState.ourProfileId,
		),
	);

	async function suggestReplyForCurrentConversation(): Promise<string> {
		const state = conversationState;
		const latestMessageId = state.messages[0]?.messageId;
		const settings = await getAutomaticReplySettings(state.ourProfileId);
		const suggestion = await suggestAiReply(
			state.ourProfileId,
			state.messages,
			settings.instructions,
			state.conversationId,
			settings.provider,
		);
		if (
			conversationState !== state ||
			state.destroyed ||
			state.messages[0]?.messageId !== latestMessageId
		)
			return "";
		return suggestion;
	}
</script>

<ChatNavBar />
<Card.Content class="relative flex min-h-0 flex-1 flex-col p-0">
	<ConversationMessages {composerHeight} />
	<MessageComposer
		conversationId={conversationState.conversationId}
		ourProfileId={conversationState.ourProfileId}
		{canSuggestReply}
		onSuggestReply={suggestReplyForCurrentConversation}
		onSend={(drafts: MessageDraft[]) => conversationState.send(drafts)}
		disabled={conversationState.loading || conversationState.error !== null}
		replyTo={conversationState.replyTo}
		onCancelReply={() => conversationState.clearReplyTo()}
		bind:height={composerHeight}
	/>
</Card.Content>
