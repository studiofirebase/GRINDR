import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	aiReplyContext,
	type AiSourceMessage,
	canSuggestAiReply,
	suggestAiReply,
} from "./ai-reply";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function textMessage({
	messageId,
	senderId,
	text,
	status = "sent",
	unsent = false,
}: {
	messageId: string;
	senderId: number;
	text: string;
	status?: AiSourceMessage["status"];
	unsent?: boolean;
}): AiSourceMessage {
	return {
		messageId,
		type: "Text",
		body: { text },
		senderId,
		unsent,
		status,
	};
}

describe("AI reply drafts", () => {
	beforeEach(() => invokeMock.mockReset());

	it("uses only sent text messages in chronological order and caps history", () => {
		const messages = Array.from({ length: 14 }, (_, index) =>
			textMessage({
				messageId: String(14 - index),
				senderId: (14 - index) % 2 === 1 ? 99 : 42,
				text: `message ${14 - index}`,
			}),
		);
		messages.unshift(
			textMessage({
				messageId: "pending",
				senderId: 42,
				text: "not sent",
				status: "pending",
			}),
			textMessage({
				messageId: "unsent",
				senderId: 99,
				text: "withdrawn",
				unsent: true,
			}),
		);

		const context = aiReplyContext(messages, 42);

		expect(context).toHaveLength(12);
		expect(context[0]).toEqual({ role: "user", content: "message 1" });
		expect(context.at(-1)).toEqual({
			role: "assistant",
			content: "message 14",
		});
	});

	it("invokes only the active profile's draft command with bounded context", async () => {
		invokeMock.mockResolvedValue("  Oi, tudo bem?  ");
		const messages = [
			textMessage({ messageId: "2", senderId: 99, text: "Oi" }),
			textMessage({ messageId: "1", senderId: 42, text: "Olá" }),
		];

		await expect(suggestAiReply(42, messages)).resolves.toBe(
			"Oi, tudo bem?",
		);
		expect(invokeMock).toHaveBeenCalledWith("ai_reply_draft", {
			profileId: "42",
			messages: [
				{ role: "assistant", content: "Olá" },
				{ role: "user", content: "Oi" },
			],
			instructions: "",
			provider: "openrouter",
		});
	});

	it("passes custom directions separately from conversation context", async () => {
		invokeMock.mockResolvedValue("Oi!");

		await suggestAiReply(
			42,
			[textMessage({ messageId: "1", senderId: 99, text: "Oi" })],
			"Seja breve e gentil",
		);

		expect(invokeMock).toHaveBeenCalledWith(
			"ai_reply_draft",
			expect.objectContaining({
				profileId: "42",
				instructions: "Seja breve e gentil",
				provider: "openrouter",
			}),
		);
	});

	it("passes Apple Intelligence selection to the local draft command", async () => {
		invokeMock.mockResolvedValue("Oi!");

		await suggestAiReply(
			42,
			[textMessage({ messageId: "1", senderId: 99, text: "Oi" })],
			"",
			undefined,
			"apple-intelligence",
		);

		expect(invokeMock).toHaveBeenCalledWith(
			"ai_reply_draft",
			expect.objectContaining({ provider: "apple-intelligence" }),
		);
	});

	it("does not request a draft when the latest message was sent by this profile", async () => {
		const messages = [
			textMessage({
				messageId: "2",
				senderId: 42,
				text: "Resposta enviada",
			}),
			textMessage({
				messageId: "1",
				senderId: 99,
				text: "Mensagem recebida",
			}),
		];

		await expect(suggestAiReply(42, messages)).rejects.toThrow(
			"Wait for an incoming text message",
		);
		expect(invokeMock).not.toHaveBeenCalled();
	});

	it("allows a draft only when the latest text in the conversation is incoming", () => {
		const incoming = textMessage({
			messageId: "incoming",
			senderId: 99,
			text: "Oi",
		});
		const outgoing = textMessage({
			messageId: "outgoing",
			senderId: 42,
			text: "Olá",
		});

		expect(canSuggestAiReply([incoming], 42)).toBe(true);
		expect(canSuggestAiReply([outgoing, incoming], 42)).toBe(false);
		expect(canSuggestAiReply([], 42)).toBe(false);
	});

	it("limits each message sent to the provider", () => {
		const context = aiReplyContext(
			[
				textMessage({
					messageId: "1",
					senderId: 99,
					text: "x".repeat(1500),
				}),
			],
			42,
		);

		expect(context[0]?.content).toHaveLength(1200);
	});
});
