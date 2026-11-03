import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	claimAutomaticReplyMock,
	claimAutomaticReplyMediaMock,
	releaseAutomaticReplyClaimMock,
	getAutomaticReplySettingsMock,
	getConversationsMock,
	getConversationMessagesMock,
	callMethodMock,
	enableAutomaticRepliesForUnconfiguredProfilesMock,
	sendMessageMock,
	suggestAiReplyMock,
	getAllDrawerMediaMock,
} = vi.hoisted(() => ({
	claimAutomaticReplyMock: vi.fn(),
	claimAutomaticReplyMediaMock: vi.fn(),
	releaseAutomaticReplyClaimMock: vi.fn(),
	getAutomaticReplySettingsMock: vi.fn(),
	getConversationsMock: vi.fn(),
	getConversationMessagesMock: vi.fn(),
	callMethodMock: vi.fn(),
	enableAutomaticRepliesForUnconfiguredProfilesMock: vi.fn(),
	sendMessageMock: vi.fn(),
	suggestAiReplyMock: vi.fn(),
	getAllDrawerMediaMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("$lib/api/methods", () => ({ callMethod: callMethodMock }));
vi.mock("$lib/api/messaging/conversations", () => ({
	getConversations: getConversationsMock,
}));
vi.mock("$lib/api/messaging/drawer", () => ({
	getAllDrawerMedia: getAllDrawerMediaMock,
}));
vi.mock("$lib/api/messaging/messages", () => ({
	getConversationMessages: getConversationMessagesMock,
	sendMessage: sendMessageMock,
}));
vi.mock("$lib/app-data/preferences.svelte", () => ({
	claimAutomaticReply: claimAutomaticReplyMock,
	claimAutomaticReplyMedia: claimAutomaticReplyMediaMock,
	releaseAutomaticReplyClaim: releaseAutomaticReplyClaimMock,
	enableAutomaticRepliesForUnconfiguredProfiles:
		enableAutomaticRepliesForUnconfiguredProfilesMock,
	getAutomaticReplySettings: getAutomaticReplySettingsMock,
}));
vi.mock("./ai-reply", () => ({
	aiReplyContext: (
		messages: Array<{ senderId: number; body: { text: string } }>,
		ourId: number,
	) =>
		messages.map((message) => ({
			role: message.senderId === ourId ? "assistant" : "user",
			content: message.body.text,
		})),
	suggestAiReply: suggestAiReplyMock,
}));
vi.mock("./media-message-draft", () => ({
	mediaMessageDraft: ({
		item,
	}: {
		item: { id: number; contentType: string };
	}) => ({
		outbound: {
			type: item.contentType.startsWith("video/") ? "Video" : "Image",
			body: { mediaId: item.id },
		},
	}),
}));

import {
	maybeSendAutomaticReply,
	scanUnreadAutomaticRepliesAtStartup,
} from "./automatic-replies";
import { fromPeer, OUR_ID, PEER_ID } from "./conversations-test-helpers";

function incoming() {
	return { ...fromPeer("conversation-1", 1), messageId: "incoming-1" };
}

function incomingPhoto() {
	return { ...incoming(), messageId: "photo-1", type: "Image", body: {} };
}

function fetchedConversation(message = incoming()) {
	return { profile: { profileId: PEER_ID }, messages: [message] };
}

beforeEach(() => {
	vi.clearAllMocks();
	getAutomaticReplySettingsMock.mockResolvedValue({
		enabled: true,
		includeDrawerMedia: false,
		instructions: "Seja breve",
		provider: "openrouter",
		revision: 1,
	});
	claimAutomaticReplyMock.mockResolvedValue(true);
	claimAutomaticReplyMediaMock.mockResolvedValue(true);
	getConversationsMock.mockResolvedValue({ entries: [], nextPage: null });
	getConversationMessagesMock.mockImplementation(() =>
		Promise.resolve(fetchedConversation()),
	);
	callMethodMock.mockResolvedValue(true);
	suggestAiReplyMock.mockResolvedValue("Oi, tudo bem?");
	sendMessageMock.mockResolvedValue(undefined);
	getAllDrawerMediaMock.mockResolvedValue([]);
});

describe("automatic AI replies", () => {
	it("checks unread chats in all five supported profiles and restores the active profile", async () => {
		const profileIds = [String(OUR_ID), "43", "44", "45", "46"];
		let activeProfileId = String(OUR_ID);
		callMethodMock.mockImplementation(
			(method: string, args?: { profileId?: string }) => {
				if (method === "profile_list")
					return Promise.resolve(
						profileIds.map((profileId, index) => ({
							profileId,
							name: `Profile ${index + 1}`,
							active: profileId === activeProfileId,
						})),
					);
				if (method === "profile_switch") {
					activeProfileId = args?.profileId ?? activeProfileId;
					return Promise.resolve(null);
				}
				if (method === "ai_reply_profile_is_active")
					return Promise.resolve(args?.profileId === activeProfileId);
				return Promise.resolve(null);
			},
		);
		getConversationsMock.mockImplementation(() =>
			Promise.resolve({
				entries: [
					{
						type: "full_conversation_v1",
						data: {
							conversationId: `conversation-${activeProfileId}`,
							unreadCount: 1,
						},
					},
				],
				nextPage: null,
			}),
		);
		getConversationMessagesMock.mockImplementation(
			({ conversationId }: { conversationId: string }) =>
				Promise.resolve({
					profile: { profileId: PEER_ID },
					messages: [
						{
							...incoming(),
							conversationId,
							messageId: `message-${activeProfileId}`,
						},
					],
				}),
		);

		await scanUnreadAutomaticRepliesAtStartup(OUR_ID);

		expect(sendMessageMock).toHaveBeenCalledTimes(5);
		expect(
			callMethodMock.mock.calls
				.filter(([method]) => method === "profile_switch")
				.map(([, args]) => args?.profileId),
		).toEqual(["43", "44", "45", "46", String(OUR_ID)]);
		expect(activeProfileId).toBe(String(OUR_ID));
	});

	it("sends one reply for an eligible incoming message", async () => {
		await maybeSendAutomaticReply({
			message: incoming() as never,
			ourProfileId: OUR_ID,
		});

		expect(suggestAiReplyMock).toHaveBeenCalledWith(
			OUR_ID,
			expect.any(Array),
			"Seja breve",
			undefined,
			"openrouter",
		);
		expect(sendMessageMock).toHaveBeenCalledExactlyOnceWith({
			toUserId: PEER_ID,
			message: { type: "Text", body: { text: "Oi, tudo bem?" } },
			sessionGuard: expect.any(Function),
		});
		expect(getAllDrawerMediaMock).not.toHaveBeenCalled();
	});

	it("retries briefly when the received message has not appeared in the conversation fetch yet", async () => {
		getConversationMessagesMock
			.mockResolvedValueOnce({
				profile: { profileId: PEER_ID },
				messages: [],
			})
			.mockResolvedValue(fetchedConversation());
		vi.useFakeTimers();
		try {
			const pending = maybeSendAutomaticReply({
				message: incoming() as never,
				ourProfileId: OUR_ID,
			});
			await vi.advanceTimersByTimeAsync(250);
			await pending;
		} finally {
			vi.useRealTimers();
		}

		expect(getConversationMessagesMock).toHaveBeenCalledTimes(3);
		expect(sendMessageMock).toHaveBeenCalledExactlyOnceWith({
			toUserId: PEER_ID,
			message: { type: "Text", body: { text: "Oi, tudo bem?" } },
			sessionGuard: expect.any(Function),
		});
	});

	it("does not send again when a message is already claimed", async () => {
		claimAutomaticReplyMock
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		const message = incoming() as never;

		await maybeSendAutomaticReply({ message, ourProfileId: OUR_ID });
		await maybeSendAutomaticReply({ message, ourProfileId: OUR_ID });

		expect(sendMessageMock).toHaveBeenCalledOnce();
	});

	it.each([
		["outgoing", { senderId: OUR_ID }],
		["unsent", { unsent: true }],
		["non-photo non-text", { type: "Video", body: {} }],
	])("ignores %s messages", async (_case, overrides) => {
		await maybeSendAutomaticReply({
			message: { ...incoming(), ...overrides } as never,
			ourProfileId: OUR_ID,
		});

		expect(getAutomaticReplySettingsMock).not.toHaveBeenCalled();
		expect(sendMessageMock).not.toHaveBeenCalled();
	});

	it("does not send when disabled or another profile is active", async () => {
		getAutomaticReplySettingsMock.mockResolvedValueOnce({
			enabled: false,
			includeDrawerMedia: false,
			instructions: "",
			revision: 0,
		});
		await maybeSendAutomaticReply({
			message: incoming() as never,
			ourProfileId: OUR_ID,
		});
		expect(getConversationMessagesMock).not.toHaveBeenCalled();

		getAutomaticReplySettingsMock.mockResolvedValue({
			enabled: true,
			includeDrawerMedia: false,
			instructions: "",
			revision: 1,
		});
		callMethodMock.mockResolvedValue(false);
		await maybeSendAutomaticReply({
			message: incoming() as never,
			ourProfileId: OUR_ID,
		});
		expect(claimAutomaticReplyMock).not.toHaveBeenCalled();
		expect(sendMessageMock).not.toHaveBeenCalled();
	});

	it("skips a reply if a newer message arrived while drafting", async () => {
		getConversationMessagesMock
			.mockResolvedValueOnce(fetchedConversation())
			.mockResolvedValueOnce(
				fetchedConversation({
					...incoming(),
					messageId: "newer-message",
				}),
			);

		await maybeSendAutomaticReply({
			message: incoming() as never,
			ourProfileId: OUR_ID,
		});

		expect(sendMessageMock).not.toHaveBeenCalled();
	});

	it("stops if automatic reply settings change while drafting", async () => {
		getAutomaticReplySettingsMock
			.mockResolvedValueOnce({
				enabled: true,
				includeDrawerMedia: false,
				instructions: "Seja breve",
				revision: 1,
			})
			.mockResolvedValueOnce({
				enabled: true,
				includeDrawerMedia: false,
				instructions: "Seja breve",
				revision: 1,
			})
			.mockResolvedValueOnce({
				enabled: false,
				includeDrawerMedia: false,
				instructions: "Seja breve",
				revision: 2,
			});

		await maybeSendAutomaticReply({
			message: incoming() as never,
			ourProfileId: OUR_ID,
		});

		expect(suggestAiReplyMock).toHaveBeenCalledOnce();
		expect(sendMessageMock).not.toHaveBeenCalled();
	});

	it("does not permanently claim an incoming message when AI generation fails", async () => {
		suggestAiReplyMock.mockRejectedValueOnce(
			new Error("OpenRouter API key is unavailable"),
		);

		await maybeSendAutomaticReply({
			message: incoming() as never,
			ourProfileId: OUR_ID,
		});

		expect(claimAutomaticReplyMock).not.toHaveBeenCalled();
		expect(sendMessageMock).not.toHaveBeenCalled();
	});

	it("releases the message claim when sending the generated reply fails", async () => {
		sendMessageMock.mockRejectedValueOnce(new Error("offline"));

		await maybeSendAutomaticReply({
			message: incoming() as never,
			ourProfileId: OUR_ID,
		});

		expect(claimAutomaticReplyMock).toHaveBeenCalledOnce();
		expect(releaseAutomaticReplyClaimMock).toHaveBeenCalledWith(
			OUR_ID,
			JSON.stringify(["conversation-1", "incoming-1"]),
			1,
		);
	});

	it("releases the message claim if the profile becomes inactive before sending", async () => {
		callMethodMock
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);

		await maybeSendAutomaticReply({
			message: incoming() as never,
			ourProfileId: OUR_ID,
		});

		expect(claimAutomaticReplyMock).toHaveBeenCalledOnce();
		expect(releaseAutomaticReplyClaimMock).toHaveBeenCalledOnce();
		expect(sendMessageMock).not.toHaveBeenCalled();
	});

	it("sends every saved drawer photo and video after the automatic text reply when enabled", async () => {
		getAutomaticReplySettingsMock.mockResolvedValue({
			enabled: true,
			includeDrawerMedia: true,
			instructions: "Seja breve",
			revision: 1,
		});
		getAllDrawerMediaMock.mockResolvedValue([
			{ id: 101, contentType: "image/jpeg" },
			{ id: 202, contentType: "video/mp4" },
		]);

		await maybeSendAutomaticReply({
			message: incoming() as never,
			ourProfileId: OUR_ID,
		});

		expect(getAllDrawerMediaMock).toHaveBeenCalledOnce();
		expect(sendMessageMock.mock.invocationCallOrder[0]).toBeLessThan(
			getAllDrawerMediaMock.mock.invocationCallOrder[0]!,
		);
		expect(
			sendMessageMock.mock.calls.map(([call]) => call.message),
		).toEqual([
			{ type: "Text", body: { text: "Oi, tudo bem?" } },
			{ type: "Image", body: { mediaId: 101 } },
			{ type: "Video", body: { mediaId: 202 } },
		]);
	});

	it("sends the text reply even if loading requested drawer media fails", async () => {
		getAutomaticReplySettingsMock.mockResolvedValue({
			enabled: true,
			includeDrawerMedia: true,
			instructions: "Seja breve",
			revision: 1,
		});
		getAllDrawerMediaMock.mockRejectedValueOnce(new Error("offline"));

		await maybeSendAutomaticReply({
			message: incoming() as never,
			ourProfileId: OUR_ID,
		});

		expect(sendMessageMock).toHaveBeenCalledExactlyOnceWith({
			toUserId: PEER_ID,
			message: { type: "Text", body: { text: "Oi, tudo bem?" } },
			sessionGuard: expect.any(Function),
		});
		expect(claimAutomaticReplyMock).toHaveBeenCalledOnce();
	});

	it.each(["Image", "ExpiringImage"])(
		"sends a generic reply to an incoming %s with no text",
		async (type) => {
			const photo = { ...incomingPhoto(), type };
			getConversationMessagesMock.mockResolvedValue(
				fetchedConversation(photo as never),
			);
			vi.useFakeTimers();
			try {
				const pending = maybeSendAutomaticReply({
					message: photo as never,
					ourProfileId: OUR_ID,
				});
				await vi.advanceTimersByTimeAsync(1500);
				await pending;
			} finally {
				vi.useRealTimers();
			}

			expect(suggestAiReplyMock).not.toHaveBeenCalled();
			expect(sendMessageMock).toHaveBeenCalledExactlyOnceWith({
				toUserId: PEER_ID,
				message: { type: "Text", body: { text: "Recebi sua foto 😊" } },
				sessionGuard: expect.any(Function),
			});
		},
	);

	it("does not send the generic photo reply if a later text arrived", async () => {
		getConversationMessagesMock.mockResolvedValue(
			fetchedConversation(incoming()),
		);
		vi.useFakeTimers();
		try {
			const pending = maybeSendAutomaticReply({
				message: incomingPhoto() as never,
				ourProfileId: OUR_ID,
			});
			await vi.advanceTimersByTimeAsync(1500);
			await pending;
		} finally {
			vi.useRealTimers();
		}

		expect(sendMessageMock).not.toHaveBeenCalled();
		expect(claimAutomaticReplyMock).not.toHaveBeenCalled();
	});
});

it.each([
	[
		"text followed by a photo",
		[
			{ ...incoming(), messageId: "photo-1", type: "Image", body: {} },
			incoming(),
		],
	],
	[
		"a photo followed by text",
		[
			incoming(),
			{ ...incoming(), messageId: "photo-1", type: "Image", body: {} },
		],
	],
])("replies when %s", async (_case, messages) => {
	getConversationMessagesMock.mockResolvedValue({
		profile: { profileId: PEER_ID },
		messages: messages as never,
	});

	await maybeSendAutomaticReply({
		message: incoming() as never,
		ourProfileId: OUR_ID,
	});

	expect(sendMessageMock).toHaveBeenCalledExactlyOnceWith({
		toUserId: PEER_ID,
		message: { type: "Text", body: { text: "Oi, tudo bem?" } },
		sessionGuard: expect.any(Function),
	});
});
