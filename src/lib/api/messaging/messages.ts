import z from "zod";

import {
	awaitBackgroundSwapEnd,
	backgroundSessionSwapInFlight,
	swapSettleWaitMs,
} from "$lib/api/background-session-swap";
import { errorUrnFromBody } from "$lib/api/error-urn";
import { fetchRest } from "$lib/api/transport";
import { demoEnabled, demoSentMessage } from "$lib/demo";
import {
	type ApiResponseMessage,
	apiResponseMessageSchema,
} from "$lib/model/messaging/messages";
import { unixTimestampMsSchema } from "$lib/model/types";
import { ws } from "$lib/ws.svelte";
import type { Conversation } from "$lib/model/messaging/conversations";
import type { MessageDraft } from "$lib/model/messaging/messages";

const conversationMessagesSchema = z.object({
	lastReadTimestamp: unixTimestampMsSchema.nullable(),
	messages: z.array(apiResponseMessageSchema),
	profile: z.object({
		distance: z.number().nullable(),
		mediaHash: z.string().nullable(),
		name: z.string().nullable(),
		onlineUntil: z.number().nullable(),
		profileId: z.int(),
		showDistance: z.boolean(),
	}),
});

export class ConversationUnavailableError extends Error {
	readonly conversationId: string;

	constructor(conversationId: string) {
		super(`Conversation ${conversationId} is no longer available`);
		this.name = "ConversationUnavailableError";
		this.conversationId = conversationId;
	}
}

export async function getConversationMessages({
	conversationId,
	pageKey,
}: {
	conversationId: string;
	pageKey?: string;
}) {
	const params = new URLSearchParams({ profile: "true" });
	if (pageKey !== undefined) params.set("pageKey", pageKey);
	const res = await fetchRest(
		`/v5/chat/conversation/${conversationId}/message?` + params.toString(),
		{ method: "GET" },
	);
	if (
		res.status === 403 &&
		errorUrnFromBody(res.text()) === "urn:gr:err:unauthorized_action"
	) {
		throw new ConversationUnavailableError(conversationId);
	}
	return res.jsonParsed(conversationMessagesSchema);
}

export async function getSingleMessage({
	conversationId,
	messageId,
}: {
	conversationId: string;
	messageId: string;
}) {
	const message = await fetchRest(
		`/v4/chat/conversation/${conversationId}/message/${messageId}`,
		{ method: "GET" },
	).then((res) =>
		res.jsonParsed(z.object({ message: apiResponseMessageSchema })),
	);
	return message;
}

export async function refreshMessagesById({
	conversationId,
	messageIds,
}: {
	conversationId: string;
	messageIds: string[];
}) {
	return await fetchRest(
		`/v4/chat/conversation/${conversationId}/message-by-id`,
		{ method: "POST", body: { messageIds } },
	).then((res) =>
		res.jsonParsed(
			z.object({ messages: z.array(apiResponseMessageSchema) }),
		),
	);
}

/**
 * Waits out a background session swap before touching the backend as the
 * visible session. The scan owns the backend mid-swap, so acting now would
 * run as another profile.
 */
async function settledSessionOrThrow(action: string): Promise<void> {
	if (
		backgroundSessionSwapInFlight() &&
		!(await awaitBackgroundSwapEnd(swapSettleWaitMs))
	) {
		throw new Error(`The app is finishing a background sync; ${action}.`);
	}
}

export async function sendMessage({
	toUserId,
	message: outbound,
	replyToMessageId,
	sessionGuard,
}: {
	toUserId: number;
	message: MessageDraft["outbound"];
	replyToMessageId?: string;
	/**
	 * Verified by callers that already switched the backend to their own
	 * session (the background AI sync). Without it, sends wait for the
	 * visible session to be back: peer-addressed sends go out as whoever
	 * the backend currently is.
	 */
	sessionGuard?: () => Promise<boolean>;
}) {
	if (backgroundSessionSwapInFlight()) {
		if (sessionGuard !== undefined) {
			if (!(await sessionGuard())) {
				throw new Error(
					"The visible session changed while sending; try again.",
				);
			}
		} else {
			await settledSessionOrThrow("try sending again");
		}
	}
	const message =
		typeof outbound === "function" ? await outbound() : outbound;
	const body = {
		type: message.type,
		target: { type: "Direct", targetId: toUserId },
		body: message.body,
		...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
	};
	// The HTTP endpoint 400s when `replyToMessageId` is set — it's only
	// accepted by the websocket command variant of this same request.
	if (replyToMessageId !== undefined) {
		if (demoEnabled) return demoSentMessage(body);
		return await ws.sendCommand({
			type: "chat.v1.message.send",
			payload: body,
			responseSchema: apiResponseMessageSchema,
		});
	}
	return await fetchRest("/v4/chat/message/send", {
		method: "POST",
		body,
	}).then((res) => res.jsonParsed(apiResponseMessageSchema));
}

export async function reactToMessage({
	conversationId,
	messageId,
	reactionType,
}: {
	conversationId: Conversation["data"]["conversationId"];
	messageId: ApiResponseMessage["messageId"];
	reactionType: number;
}) {
	await settledSessionOrThrow("try reacting again");
	return await fetchRest("/v4/chat/message/reaction", {
		method: "POST",
		body: { conversationId, messageId, reactionType },
	});
}

export async function deleteMessageForMe({
	conversationId,
	messageId,
}: {
	conversationId: Conversation["data"]["conversationId"];
	messageId: ApiResponseMessage["messageId"];
}) {
	await settledSessionOrThrow("try deleting again");
	return await fetchRest(`/v4/chat/message/delete`, {
		method: "POST",
		body: { conversationId, messageId },
	}).then((res) => res.assertOk());
}

export async function unsendMessage({
	conversationId,
	messageId,
}: {
	conversationId: Conversation["data"]["conversationId"];
	messageId: ApiResponseMessage["messageId"];
}) {
	await settledSessionOrThrow("try unsending again");
	return await fetchRest(`/v4/chat/message/unsend`, {
		method: "POST",
		body: { conversationId, messageId },
	}).then((res) => res.assertOk());
}
