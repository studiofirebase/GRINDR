import { isTauri } from "@tauri-apps/api/core";
import { toast } from "svelte-sonner";

import { getConversations } from "$lib/api/messaging/conversations";
import { getAllDrawerMedia } from "$lib/api/messaging/drawer";
import {
	getConversationMessages,
	sendMessage,
} from "$lib/api/messaging/messages";
import { callMethod } from "$lib/api/methods";
import {
	claimAutomaticReply,
	claimAutomaticReplyMedia,
	enableAutomaticRepliesForUnconfiguredProfiles,
	getAutomaticReplySettings,
	releaseAutomaticReplyClaim,
} from "$lib/app-data/preferences.svelte";
import { demoEnabled } from "$lib/demo";
import { webBackendEnabled } from "$lib/web/bridge";
import type { ApiResponseMessage } from "$lib/model/messaging/messages";
import { aiReplyContext, suggestAiReply } from "./ai-reply";
import { mediaMessageDraft } from "./media-message-draft";

const inFlight = new Set<string>();
const profileScans = new Map<number, Promise<void>>();
let startupScan: Promise<void> | null = null;
const photoReplyDelayMs = 1500;
const incomingVisibilityRetries = 3;
const incomingVisibilityRetryDelayMs = 250;

function isIncomingText(
	message: ApiResponseMessage,
	ourProfileId: number,
): boolean {
	return (
		message.senderId !== ourProfileId &&
		!message.unsent &&
		message.type === "Text" &&
		message.body.text.trim() !== ""
	);
}

function isIncomingPhoto(
	message: ApiResponseMessage,
	ourProfileId: number,
): boolean {
	return (
		message.senderId !== ourProfileId &&
		!message.unsent &&
		(message.type === "Image" || message.type === "ExpiringImage")
	);
}

function sameSettings(
	a: Awaited<ReturnType<typeof getAutomaticReplySettings>>,
	b: Awaited<ReturnType<typeof getAutomaticReplySettings>>,
): boolean {
	return (
		a.enabled &&
		b.enabled &&
		a.includeDrawerMedia === b.includeDrawerMedia &&
		a.revision === b.revision &&
		a.provider === b.provider &&
		a.instructions === b.instructions
	);
}

async function profileIsActive(profileId: number): Promise<boolean> {
	return callMethod("ai_reply_profile_is_active", {
		profileId: String(profileId),
	});
}

async function profileIsStillActive(profileId: number): Promise<boolean> {
	try {
		return await profileIsActive(profileId);
	} catch {
		return false;
	}
}

function numericProfileId(profileId: string): number | null {
	const parsed = Number(profileId);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function scanUnreadConversations(profileId: number): Promise<boolean> {
	const visitedPages = new Set<number>();
	const visitedConversations = new Set<string>();
	let page: number | null = 1;
	let completed = true;

	while (page !== null && !visitedPages.has(page)) {
		if (!(await profileIsStillActive(profileId))) return false;
		visitedPages.add(page);

		let inbox: Awaited<ReturnType<typeof getConversations>>;
		try {
			inbox = await getConversations({ page });
		} catch {
			return false;
		}
		if (!(await profileIsStillActive(profileId))) return false;

		for (const entry of inbox.entries) {
			const { conversationId, unreadCount } = entry.data;
			if (unreadCount <= 0 || visitedConversations.has(conversationId))
				continue;
			visitedConversations.add(conversationId);
			if (!(await profileIsStillActive(profileId))) return false;

			let conversation: Awaited<
				ReturnType<typeof getConversationMessages>
			>;
			try {
				conversation = await getConversationMessages({
					conversationId,
				});
			} catch {
				completed = false;
				continue;
			}
			if (!(await profileIsStillActive(profileId))) return false;

			const latest = conversation.messages[0];
			if (
				latest?.conversationId === conversationId &&
				(isIncomingText(latest, profileId) ||
					isIncomingPhoto(latest, profileId))
			) {
				await maybeSendAutomaticReply({
					message: latest,
					ourProfileId: profileId,
				});
			}
		}
		page = inbox.nextPage;
	}

	return completed;
}

async function scanSavedProfilesOnStartup(
	startingProfileId: number,
): Promise<void> {
	const startingId = String(startingProfileId);
	if (!(await profileIsStillActive(startingProfileId))) return;

	const savedProfiles = await callMethod("profile_list");
	const savedIds = new Set(savedProfiles.map(({ profileId }) => profileId));
	const orderedIds = [
		startingId,
		...savedProfiles
			.map(({ profileId }) => profileId)
			.filter((profileId) => profileId !== startingId),
	];
	await enableAutomaticRepliesForUnconfiguredProfiles(orderedIds);

	const enabledIds: string[] = [];
	for (const profileId of orderedIds) {
		if ((await getAutomaticReplySettings(profileId)).enabled)
			enabledIds.push(profileId);
	}
	if (enabledIds.length === 0) return;

	let currentId = startingId;
	let hadFailures = false;
	try {
		for (const profileId of enabledIds) {
			const targetId = numericProfileId(profileId);
			if (targetId === null) {
				hadFailures = true;
				continue;
			}
			const currentNumericId = numericProfileId(currentId);
			if (
				currentNumericId === null ||
				!(await profileIsStillActive(currentNumericId))
			)
				break;

			if (profileId !== currentId) {
				// Restore requires the starting profile to be present in local storage.
				if (!savedIds.has(profileId) || !savedIds.has(startingId)) {
					hadFailures = true;
					continue;
				}
				try {
					await callMethod("profile_switch", { profileId });
					currentId = profileId;
				} catch {
					hadFailures = true;
					if (await profileIsStillActive(targetId))
						currentId = profileId;
					else continue;
				}
			}

			if (!(await profileIsStillActive(targetId))) break;
			if (!(await scanUnreadConversations(targetId))) {
				if (!(await profileIsStillActive(targetId))) break;
				hadFailures = true;
			}
		}
	} catch {
		hadFailures = true;
	} finally {
		const currentNumericId = numericProfileId(currentId);
		if (
			currentId !== startingId &&
			currentNumericId !== null &&
			(await profileIsStillActive(currentNumericId))
		) {
			try {
				await callMethod("profile_switch", { profileId: startingId });
			} catch {
				hadFailures = true;
			}
		}
	}

	if (hadFailures)
		toast.error(
			"Some saved profiles could not be checked for unread chats.",
		);
}

/** Checks saved profiles one at a time before the authenticated UI is shown. */
export function scanUnreadAutomaticRepliesAtStartup(
	startingProfileId: number,
): Promise<void> {
	if (!(isTauri() || webBackendEnabled) || demoEnabled)
		return Promise.resolve();
	startupScan ??= scanSavedProfilesOnStartup(startingProfileId).catch(() => {
		toast.error("Could not check saved profiles for unread chats.");
	});
	return startupScan;
}

/** Rechecks the active profile's unread conversations after a reconnect or resync. */
export function scanUnreadAutomaticRepliesForProfile(
	profileId: number,
): Promise<void> {
	if (!(isTauri() || webBackendEnabled) || demoEnabled)
		return Promise.resolve();
	const pending = profileScans.get(profileId);
	if (pending) return pending;

	const scan = (async () => {
		if (!(await profileIsStillActive(profileId))) return;
		if (!(await getAutomaticReplySettings(profileId)).enabled) return;
		const completed = await scanUnreadConversations(profileId);
		if (!completed && (await profileIsStillActive(profileId)))
			toast.error("Could not check unread chats for automatic replies.");
	})()
		.catch(() => {
			toast.error("Could not check unread chats for automatic replies.");
		})
		.finally(() => {
			profileScans.delete(profileId);
		});
	profileScans.set(profileId, scan);
	return scan;
}

async function latestIncomingText({
	conversationId,
	messageId,
	profileId,
	expectedPeerId,
	expectedTimestamp,
}: {
	conversationId: string;
	messageId: string;
	profileId: number;
	expectedPeerId?: number;
	expectedTimestamp: number;
}) {
	for (let attempt = 0; attempt < incomingVisibilityRetries; attempt++) {
		const result = await getConversationMessages({ conversationId });
		const peerId = result.profile.profileId;
		const latestTextIndex = result.messages.findIndex((item) =>
			isIncomingText(item, profileId),
		);
		const latestText =
			latestTextIndex === -1
				? undefined
				: result.messages[latestTextIndex];
		if (
			!Number.isSafeInteger(peerId) ||
			peerId <= 0 ||
			peerId === profileId ||
			(expectedPeerId !== undefined && peerId !== expectedPeerId)
		)
			return null;
		const target = result.messages.find(
			(item) => item.messageId === messageId,
		);
		const newerOutgoingText = result.messages
			.slice(0, latestTextIndex === -1 ? 0 : latestTextIndex)
			.some(
				(item) =>
					item.senderId === profileId &&
					!item.unsent &&
					item.type === "Text" &&
					item.body.text.trim() !== "",
			);
		if (target !== undefined) {
			if (
				!isIncomingText(target, profileId) ||
				latestText?.messageId !== messageId ||
				target.conversationId !== conversationId ||
				newerOutgoingText
			)
				return null;
			return { messages: result.messages, peerId };
		}

		const targetWasSuperseded = result.messages.some(
			(item) => item.timestamp > expectedTimestamp,
		);
		const otherIncomingIsAtLeastAsNew =
			latestText !== undefined &&
			latestText.messageId !== messageId &&
			latestText.timestamp >= expectedTimestamp;
		if (
			targetWasSuperseded ||
			otherIncomingIsAtLeastAsNew ||
			attempt === incomingVisibilityRetries - 1
		)
			return null;
		await new Promise<void>((resolve) =>
			setTimeout(resolve, incomingVisibilityRetryDelayMs),
		);
	}
	return null;
}

export async function maybeSendAutomaticReply({
	message,
	ourProfileId,
}: {
	message: ApiResponseMessage;
	ourProfileId: number;
}): Promise<void> {
	if (isIncomingPhoto(message, ourProfileId)) {
		await maybeSendGenericPhotoReply(message, ourProfileId);
		return;
	}
	if (!isIncomingText(message, ourProfileId)) return;
	const claimId = JSON.stringify([message.conversationId, message.messageId]);
	const key = `${ourProfileId}\u0000${claimId}`;
	if (inFlight.has(key)) return;
	inFlight.add(key);

	try {
		const settings = await getAutomaticReplySettings(ourProfileId);
		if (!settings.enabled || !(await profileIsActive(ourProfileId))) return;
		const latest = await latestIncomingText({
			conversationId: message.conversationId,
			messageId: message.messageId,
			profileId: ourProfileId,
			expectedTimestamp: message.timestamp,
		});
		if (!latest) return;
		const { messages, peerId } = latest;
		if (
			!(await profileIsActive(ourProfileId)) ||
			!sameSettings(
				settings,
				await getAutomaticReplySettings(ourProfileId),
			) ||
			!(await profileIsActive(ourProfileId))
		)
			return;

		const context = aiReplyContext(
			messages.map((item) => ({
				messageId: item.messageId,
				senderId: item.senderId,
				type: item.type,
				body: item.body,
				unsent: item.unsent,
				status: "sent" as const,
			})),
			ourProfileId,
		);
		if (context.at(-1)?.role !== "user") return;
		const draft = await suggestAiReply(
			ourProfileId,
			messages.map((item) => ({
				messageId: item.messageId,
				senderId: item.senderId,
				type: item.type,
				body: item.body,
				unsent: item.unsent,
				status: "sent" as const,
			})),
			settings.instructions,
			undefined,
			settings.provider,
		);
		if (
			!sameSettings(
				settings,
				await getAutomaticReplySettings(ourProfileId),
			)
		)
			return;

		const stillLatest = await latestIncomingText({
			conversationId: message.conversationId,
			messageId: message.messageId,
			profileId: ourProfileId,
			expectedPeerId: peerId,
			expectedTimestamp: message.timestamp,
		});
		if (
			!stillLatest ||
			!(await profileIsActive(ourProfileId)) ||
			!sameSettings(
				settings,
				await getAutomaticReplySettings(ourProfileId),
			)
		)
			return;

		const claimed = await claimAutomaticReply(
			ourProfileId,
			claimId,
			settings.revision,
		);
		if (!claimed) return;
		if (
			!(await profileIsActive(ourProfileId)) ||
			!sameSettings(
				settings,
				await getAutomaticReplySettings(ourProfileId),
			)
		) {
			await releaseAutomaticReplyClaim(
				ourProfileId,
				claimId,
				settings.revision,
			);
			return;
		}

		try {
			await sendMessage({
				toUserId: peerId,
				message: { type: "Text", body: { text: draft } },
				// The background sync owns the backend mid-scan: proceed
				// only while this profile is still the active session.
				sessionGuard: () => profileIsActive(ourProfileId),
			});
		} catch (error) {
			await releaseAutomaticReplyClaim(
				ourProfileId,
				claimId,
				settings.revision,
			);
			throw error;
		}

		try {
			if (
				!settings.includeDrawerMedia ||
				!(await profileIsActive(ourProfileId)) ||
				!sameSettings(
					settings,
					await getAutomaticReplySettings(ourProfileId),
				)
			)
				return;
			const drawerMedia = await getAllDrawerMedia();
			if (
				drawerMedia.length === 0 ||
				!(await profileIsActive(ourProfileId)) ||
				!sameSettings(
					settings,
					await getAutomaticReplySettings(ourProfileId),
				) ||
				!(await claimAutomaticReplyMedia(
					ourProfileId,
					message.conversationId,
					settings.revision,
				))
			)
				return;
			for (const item of drawerMedia) {
				if (
					!(await profileIsActive(ourProfileId)) ||
					!sameSettings(
						settings,
						await getAutomaticReplySettings(ourProfileId),
					)
				)
					return;
				await sendMessage({
					toUserId: peerId,
					message: mediaMessageDraft({ item, expiring: false })
						.outbound,
					// Same-session send owned by the background sync.
					sessionGuard: () => profileIsActive(ourProfileId),
				});
			}
		} catch {
			toast.error("Reply sent, but saved media could not be sent.");
		}
	} catch {
		toast.error(
			"Automatic reply failed. Check the conversation and OpenRouter settings.",
		);
	} finally {
		inFlight.delete(key);
	}
}

async function maybeSendGenericPhotoReply(
	message: ApiResponseMessage,
	ourProfileId: number,
): Promise<void> {
	const claimId = JSON.stringify([message.conversationId, message.messageId]);
	const key = `${ourProfileId}\u0000${claimId}`;
	if (inFlight.has(key)) return;
	inFlight.add(key);

	try {
		const settings = await getAutomaticReplySettings(ourProfileId);
		if (!settings.enabled || !(await profileIsActive(ourProfileId))) return;

		await new Promise<void>((resolve) =>
			setTimeout(resolve, photoReplyDelayMs),
		);

		const latest = await getConversationMessages({
			conversationId: message.conversationId,
		});
		const peerId = latest.profile.profileId;
		if (
			latest.messages[0]?.messageId !== message.messageId ||
			latest.messages[0].conversationId !== message.conversationId ||
			!isIncomingPhoto(latest.messages[0], ourProfileId) ||
			!Number.isSafeInteger(peerId) ||
			peerId <= 0 ||
			peerId === ourProfileId ||
			!(await profileIsActive(ourProfileId)) ||
			!sameSettings(
				settings,
				await getAutomaticReplySettings(ourProfileId),
			)
		)
			return;

		if (
			!(await claimAutomaticReply(
				ourProfileId,
				claimId,
				settings.revision,
			))
		)
			return;
		if (
			!(await profileIsActive(ourProfileId)) ||
			!sameSettings(
				settings,
				await getAutomaticReplySettings(ourProfileId),
			)
		) {
			await releaseAutomaticReplyClaim(
				ourProfileId,
				claimId,
				settings.revision,
			);
			return;
		}

		try {
			await sendMessage({
				toUserId: peerId,
				message: { type: "Text", body: { text: "Recebi sua foto 😊" } },
				// Same-session send owned by the background sync.
				sessionGuard: () => profileIsActive(ourProfileId),
			});
		} catch (error) {
			await releaseAutomaticReplyClaim(
				ourProfileId,
				claimId,
				settings.revision,
			);
			throw error;
		}
	} catch {
		toast.error("Automatic photo reply failed. Check the conversation.");
	} finally {
		inFlight.delete(key);
	}
}
