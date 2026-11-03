import { invoke } from "@tauri-apps/api/core";

import { getConversationMessages } from "$lib/api/messaging/messages";
import { callMethod } from "$lib/api/methods";
import type { AiReplyProvider } from "$lib/app-data/preferences.svelte";
import type { ApiResponseMessage } from "$lib/model/messaging/messages";

export type AiChatMessage = { role: "user" | "assistant"; content: string };

export type AiSourceMessage = {
	messageId?: string;
	senderId: number;
	type: string;
	body?: unknown;
	unsent: boolean;
	status: "sent" | "pending" | "error";
};

const maxContextMessages = 12;
const maxMessageLength = 1200;
const firstIncomingTextCache = new Map<string, AiSourceMessage>();
const firstIncomingTextLookups = new Map<
	string,
	Promise<AiSourceMessage | undefined>
>();

function isSentTextMessage(
	message: AiSourceMessage,
): message is AiSourceMessage & {
	type: "Text";
	body: { text: string };
	status: "sent";
} {
	if (
		message.status !== "sent" ||
		message.unsent ||
		message.type !== "Text" ||
		typeof message.body !== "object" ||
		message.body === null ||
		!("text" in message.body) ||
		typeof message.body.text !== "string"
	)
		return false;
	return message.body.text.trim() !== "";
}

export function aiReplyContext(
	messages: readonly AiSourceMessage[],
	ourProfileId: number,
): AiChatMessage[] {
	const sentTextMessages = messages.filter(isSentTextMessage);
	// Source messages are newest-first; reserve one slot for the first
	// incoming text.
	const selectedIndexes = new Set(
		sentTextMessages.slice(0, maxContextMessages).map((_, index) => index),
	);
	const firstIncomingIndex = sentTextMessages.findLastIndex(
		(message) => message.senderId !== ourProfileId,
	);
	if (firstIncomingIndex >= maxContextMessages) {
		selectedIndexes.delete(maxContextMessages - 1);
		selectedIndexes.add(firstIncomingIndex);
	}

	return [...selectedIndexes]
		.sort((a, b) => b - a)
		.map((index) => sentTextMessages[index]!)
		.map((message) => ({
			role: message.senderId === ourProfileId ? "assistant" : "user",
			content: message.body.text.trim().slice(0, maxMessageLength),
		}));
}

function isIncomingText(
	message: AiSourceMessage,
	ourProfileId: number,
): boolean {
	return isSentTextMessage(message) && message.senderId !== ourProfileId;
}

function sourceMessage(message: ApiResponseMessage): AiSourceMessage {
	return { ...message, status: "sent" };
}

async function firstIncomingText(
	profileId: number,
	conversationId: string,
	messages: readonly AiSourceMessage[],
): Promise<AiSourceMessage | undefined> {
	const cacheKey = `${profileId}\u0000${conversationId}`;
	const cached = firstIncomingTextCache.get(cacheKey);
	if (cached) return cached;
	const pending = firstIncomingTextLookups.get(cacheKey);
	if (pending) return pending;

	const lookup = findFirstIncomingText(
		profileId,
		conversationId,
		messages,
		cacheKey,
	);
	firstIncomingTextLookups.set(cacheKey, lookup);
	try {
		return await lookup;
	} finally {
		if (firstIncomingTextLookups.get(cacheKey) === lookup)
			firstIncomingTextLookups.delete(cacheKey);
	}
}

async function findFirstIncomingText(
	profileId: number,
	conversationId: string,
	messages: readonly AiSourceMessage[],
	cacheKey: string,
): Promise<AiSourceMessage | undefined> {
	let first = messages.findLast((message) =>
		isIncomingText(message, profileId),
	);
	let pageKey = messages.at(-1)?.messageId;
	const seenPageKeys = new Set<string>();
	let complete = pageKey === undefined;

	// Pages are newest-first, so keep walking to the oldest page and replace
	// the anchor whenever an earlier incoming text is found.
	while (pageKey && !seenPageKeys.has(pageKey)) {
		if (!(await activeProfileMatches(profileId))) return first;
		seenPageKeys.add(pageKey);
		let page: Awaited<ReturnType<typeof getConversationMessages>>;
		try {
			page = await getConversationMessages({ conversationId, pageKey });
		} catch {
			return first;
		}
		if (!(await activeProfileMatches(profileId))) return first;
		if (page.messages.length === 0) {
			complete = true;
			break;
		}
		const earlier = page.messages.findLast(
			(message) =>
				!message.unsent &&
				message.senderId !== profileId &&
				message.type === "Text" &&
				message.body.text.trim() !== "",
		);
		if (earlier) first = sourceMessage(earlier);
		const nextPageKey = page.messages.at(-1)?.messageId;
		if (!nextPageKey || nextPageKey === pageKey) {
			complete = true;
			break;
		}
		pageKey = nextPageKey;
	}

	if (first && complete) firstIncomingTextCache.set(cacheKey, first);
	return first;
}

async function activeProfileMatches(profileId: number): Promise<boolean> {
	try {
		return await callMethod("ai_reply_profile_is_active", {
			profileId: String(profileId),
		});
	} catch {
		return false;
	}
}

export function canSuggestAiReply(
	messages: readonly AiSourceMessage[],
	ourProfileId: number,
): boolean {
	return aiReplyContext(messages, ourProfileId).at(-1)?.role === "user";
}

export async function suggestAiReply(
	profileId: number,
	messages: readonly AiSourceMessage[],
	instructions = "",
	conversationId?: string,
	provider: AiReplyProvider = "openrouter",
): Promise<string> {
	if (!canSuggestAiReply(messages, profileId)) {
		throw new Error(
			"Wait for an incoming text message before drafting a reply.",
		);
	}
	let contextMessages = messages;
	if (conversationId) {
		const first = await firstIncomingText(
			profileId,
			conversationId,
			messages,
		);
		if (
			first &&
			!messages.some((message) => message.messageId === first.messageId)
		)
			contextMessages = [...messages, first];
	}
	const context = aiReplyContext(contextMessages, profileId);
	const result = await invoke<string>("ai_reply_draft", {
		profileId: String(profileId),
		messages: context,
		instructions,
		provider,
	});
	const draft = result.trim();
	if (draft === "")
		throw new Error("The AI provider returned an empty draft.");
	return draft;
}
