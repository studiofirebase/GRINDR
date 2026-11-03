// @vitest-environment jsdom

import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const {
	getConversationsMock,
	messageSentHandlers,
	conversationDeleteHandlers,
} = vi.hoisted(() => ({
	getConversationsMock: vi.fn(),
	messageSentHandlers: [] as ((event: unknown) => void)[],
	conversationDeleteHandlers: [] as ((event: unknown) => void)[],
}));

vi.mock("$app/state", () => ({ page: { route: { id: "/chat" } } }));
vi.mock("$lib/api/error-toast", () => ({ showErrorToast: vi.fn() }));
vi.mock("$lib/api/messaging/conversations", () => ({
	getConversations: getConversationsMock,
	markConversationAsRead: vi.fn(() => Promise.resolve()),
	deleteConversationForMe: vi.fn(() => Promise.resolve()),
	setConversationPinned: vi.fn(() => Promise.resolve()),
	setConversationMuted: vi.fn(() => Promise.resolve()),
}));
vi.mock("$lib/util/breakpoints.svelte", () => ({
	below: () => ({ current: false }),
}));
vi.mock("$lib/util/reconcile", () => ({
	reconciler: {
		subscribe() {
			return vi.fn();
		},
	},
}));
vi.mock("$lib/ws.svelte", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/ws.svelte")>()),
	ws: {
		on(eventType: string, _schema: unknown, handler: (e: unknown) => void) {
			if (eventType === "chat.v1.message_sent")
				messageSentHandlers.push(handler);
			if (eventType === "chat.v1.conversation.delete")
				conversationDeleteHandlers.push(handler);
			return Promise.resolve(vi.fn());
		},
	},
}));

import { beginBackgroundSessionSwap } from "$lib/api/background-session-swap";
import { ConversationsState } from "./conversations-state.svelte";
import {
	conversation,
	incomingMessage,
	microtasks,
	OUR_ID,
	PEER_ID,
	settled,
} from "./conversations-test-helpers";

beforeEach(() => {
	vi.clearAllMocks();
	getConversationsMock.mockReset();
	messageSentHandlers.length = 0;
	conversationDeleteHandlers.length = 0;
});

function emitMessageSent(payload: unknown) {
	messageSentHandlers[0]?.({ payload });
}

describe("ConversationsState background session swaps", () => {
	async function settledInbox() {
		getConversationsMock.mockResolvedValue({
			entries: [conversation("a:1", 1000)],
			nextPage: null,
		});
		const state = new ConversationsState({
			ourProfileId: OUR_ID,
			onIncomingMessage: vi.fn(),
		});
		await settled(state);
		onTestFinished(() => state.destroy());
		return state;
	}

	it("drops live messages that arrive while another profile owns the backend", async () => {
		const onIncoming = vi.fn();
		getConversationsMock.mockResolvedValue({ entries: [], nextPage: null });
		const state = new ConversationsState({
			ourProfileId: OUR_ID,
			onIncomingMessage: onIncoming,
		});
		await settled(state);
		onTestFinished(() => state.destroy());

		const endSwap = beginBackgroundSessionSwap();
		try {
			emitMessageSent(
				incomingMessage("b:1", { timestamp: 2000, senderId: PEER_ID }),
			);
			await microtasks();
			expect(onIncoming).not.toHaveBeenCalled();
			expect(state.entries).toHaveLength(0);
		} finally {
			endSwap();
		}
	});

	it("drops conversation deletes that arrive while another profile owns the backend", async () => {
		const state = await settledInbox();
		const before = state.entries.length;
		expect(before).toBeGreaterThan(0);

		const endSwap = beginBackgroundSessionSwap();
		try {
			conversationDeleteHandlers[0]?.({
				payload: {
					conversationIds: [state.entries[0]?.data.conversationId],
				},
			});
			await microtasks();
			expect(state.entries).toHaveLength(before);
		} finally {
			endSwap();
		}
	});

	it("holds inbox syncs until the swap settles", async () => {
		const state = await settledInbox();
		getConversationsMock.mockClear();

		const endSwap = beginBackgroundSessionSwap();
		try {
			const pending = state.refresh();
			await microtasks();
			await microtasks();
			expect(getConversationsMock).not.toHaveBeenCalled();
			endSwap();
			await pending;
			expect(getConversationsMock).toHaveBeenCalled();
		} finally {
			endSwap();
		}
	});
});
