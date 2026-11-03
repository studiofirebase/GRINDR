// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { callMethodMock, closeMock, listenMock } = vi.hoisted(() => ({
	callMethodMock: vi.fn(),
	closeMock: vi.fn(),
	listenMock: vi.fn(),
}));

vi.mock("$lib/api/methods", () => ({ callMethod: callMethodMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ close: closeMock }),
}));

import BubblePage from "./+page.svelte";

const payload = {
	profileId: "43",
	profileName: "two@example.com",
	conversationId: "c1",
	peerName: "Alex",
	peerAvatarMediaHash: "avatar-hash",
	snippet: "hey there",
	unread: 3,
};

beforeEach(() => {
	callMethodMock.mockReset().mockResolvedValue(payload);
	closeMock.mockReset().mockResolvedValue(undefined);
	listenMock.mockReset().mockResolvedValue(() => {});
});

afterEach(() => {
	cleanup();
});

describe("message balloon", () => {
	it("shows the sender, snippet and session", async () => {
		render(BubblePage);

		await screen.findByText("Alex");
		await screen.findByText("hey there");
		expect(
			await screen.findByRole("img", { name: "Alex's profile picture" }),
		).toBeTruthy();
		expect(await screen.findByText(/two@example\.com/)).toBeTruthy();
		expect(callMethodMock).toHaveBeenCalledWith("bubble_take");
	});

	it("updates the visible sender when background sync completes", async () => {
		render(BubblePage);
		await screen.findByText("Alex");
		const onUpdate = listenMock.mock.calls.find(
			([event]) => event === "bubble:update",
		)?.[1] as ((event: { payload: typeof payload }) => void) | undefined;

		expect(onUpdate).toBeTypeOf("function");
		onUpdate?.({
			payload: {
				...payload,
				peerName: "Morgan",
				peerAvatarMediaHash: "updated-avatar-hash",
			},
		});

		await screen.findByText("Morgan");
		expect(
			screen.getByRole("img", { name: "Morgan's profile picture" }),
		).toBeTruthy();
		expect(closeMock).not.toHaveBeenCalled();
	});

	it("opens the session on Open", async () => {
		render(BubblePage);
		await screen.findByText("Alex");

		await fireEvent.click(screen.getByRole("button", { name: "Open" }));

		expect(callMethodMock).toHaveBeenCalledWith("bubble_open", {
			profileId: "43",
			profileName: "two@example.com",
		});
	});

	it("closes itself when there is no pending message", async () => {
		callMethodMock.mockResolvedValue(null);
		render(BubblePage);

		await vi.waitFor(() => {
			expect(callMethodMock).toHaveBeenCalledWith("bubble_close");
		});
	});
});
