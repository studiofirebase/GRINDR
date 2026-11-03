import { beforeEach, describe, expect, it, vi } from "vitest";

const { customMock } = vi.hoisted(() => ({ customMock: vi.fn() }));

vi.mock("svelte-sonner", () => ({
	toast: { custom: customMock, dismiss: vi.fn() },
}));
vi.mock("$app/navigation", () => ({ goto: vi.fn() }));

import type { ApiResponseMessage } from "$lib/model/messaging/messages";
import { showIncomingMessageToast } from "./incoming-message-toast-manager";
import IncomingMessageToast from "./IncomingMessageToast.svelte";

const message = {
	messageId: "m-a:1-2000",
	conversationId: "a:1",
	senderId: 2,
	timestamp: 2000,
	unsent: false,
	type: "Text",
	body: { text: "hi" },
} as unknown as ApiResponseMessage;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("incoming message balloon", () => {
	it("pins a persistent balloon with the sender picture by conversation", () => {
		showIncomingMessageToast({
			message,
			sender: { name: "Peer", avatarMediaHash: "abc123" },
			conversationId: "a:1",
		});

		expect(customMock).toHaveBeenCalledExactlyOnceWith(
			IncomingMessageToast,
			expect.objectContaining({
				id: "a:1",
				duration: Number.POSITIVE_INFINITY,
				componentProps: expect.objectContaining({
					message,
					sender: { name: "Peer", avatarMediaHash: "abc123" },
				}),
			}),
		);
	});
});
