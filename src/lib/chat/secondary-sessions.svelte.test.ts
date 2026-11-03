// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const { callMethodMock, isTauriMock, listenMock, noteLiveMock } = vi.hoisted(
	() => ({
		callMethodMock: vi.fn(),
		isTauriMock: vi.fn(() => true),
		listenMock: vi.fn(),
		noteLiveMock: vi.fn(),
	}),
);

vi.mock("@tauri-apps/api/core", () => ({
	isTauri: isTauriMock,
	invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
	// Fall back to a no-op unlisten until a test arms the mock: module-level
	// singletons subscribe at import time, before any beforeEach runs.
	listen: (...args: unknown[]) =>
		(listenMock(...args) as Promise<() => void> | undefined) ??
		Promise.resolve(() => {}),
}));
vi.mock("$lib/api/methods", () => ({
	callMethod: callMethodMock,
	asAppError: (error: unknown) => error,
}));
vi.mock("$lib/chat/other-sessions-unread.svelte", () => ({
	noteLiveBackgroundMessage: noteLiveMock,
}));
vi.mock("$lib/demo", () => ({ demoEnabled: false }));

import {
	refreshSecondaryStatus,
	secondarySessions,
	startSecondarySessionsListener,
} from "./secondary-sessions.svelte";

type Handler = (event: { payload: unknown }) => void;
let handlers: Record<string, Handler> = {};

function backgroundMessage(overrides: Record<string, unknown> = {}) {
	return {
		profile_id: "43",
		profile_name: "two@example.com",
		event: {
			type: "chat.v1.message_sent",
			payload: {
				messageId: "m1",
				conversationId: "c1",
				senderId: 777,
				timestamp: Date.now(),
				type: "Text",
				body: { text: "hey, are you there?" },
			},
		},
		...overrides,
	};
}

beforeEach(() => {
	handlers = {};
	secondarySessions.resetForTesting();
	callMethodMock.mockReset().mockImplementation((method: string) => {
		if (method === "secondary_status")
			return Promise.resolve([
				{ profileId: "42", wsOnline: false },
				{ profileId: "43", wsOnline: true },
			]);
		return Promise.resolve(null);
	});
	isTauriMock.mockReset().mockReturnValue(true);
	listenMock
		.mockReset()
		.mockImplementation((event: string, handler: Handler) => {
			handlers[event] = handler;
			return Promise.resolve(() => {});
		});
	noteLiveMock.mockReset();
});

describe("secondary sessions", () => {
	it("loads which profiles hold a live background socket", async () => {
		await refreshSecondaryStatus();

		expect(callMethodMock).toHaveBeenCalledWith("secondary_status");
		expect(secondarySessions.isOnline("43")).toBe(true);
		expect(secondarySessions.isOnline("42")).toBe(false);
		expect(secondarySessions.onlineCount).toBe(1);
	});

	it("balloons incoming background chat messages with the live text", () => {
		const stop = startSecondarySessionsListener();
		handlers["grindr:background:chat_v1_message_sent"]?.({
			payload: backgroundMessage(),
		});

		expect(noteLiveMock).toHaveBeenCalledWith({
			profileId: "43",
			profileName: "two@example.com",
			snippet: "hey, are you there?",
		});
		stop();
	});

	it("ignores our own echoes and unparseable payloads", () => {
		startSecondarySessionsListener();
		const handler = handlers["grindr:background:chat_v1_message_sent"];
		handler?.({
			payload: backgroundMessage({
				event: {
					type: "chat.v1.message_sent",
					payload: {
						messageId: "m2",
						conversationId: "c1",
						senderId: 43,
						timestamp: Date.now(),
						type: "Text",
						body: { text: "my own reply" },
					},
				},
			}),
		});
		handler?.({ payload: { profile_id: "43", event: null } });
		handler?.({ payload: { profile_id: "", event: null } });

		expect(noteLiveMock).not.toHaveBeenCalled();
	});

	it("stays quiet without the desktop backend", async () => {
		isTauriMock.mockReturnValue(false);

		await refreshSecondaryStatus();
		const stop = startSecondarySessionsListener();

		expect(callMethodMock).not.toHaveBeenCalled();
		expect(listenMock).not.toHaveBeenCalled();
		expect(secondarySessions.entries).toEqual([]);
		stop();
	});
});
