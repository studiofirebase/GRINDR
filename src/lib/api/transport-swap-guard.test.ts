// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

const { invokeMock, callMethodMock, signOutMock } = vi.hoisted(() => ({
	invokeMock: vi.fn(),
	callMethodMock: vi.fn(),
	signOutMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
	invoke: invokeMock,
}));
vi.mock("$app/state", () => ({ page: { route: { id: "/(protected)/chat" } } }));
vi.mock("$lib/api/methods", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/api/methods")>()),
	callMethod: callMethodMock,
}));
vi.mock("$lib/api/sign-out", () => ({ signOut: signOutMock }));
vi.mock("$lib/api/google-handoff-state.svelte", () => ({
	googleHandoffState: { phase: "idle" },
}));

import { encode } from "@msgpack/msgpack";

import {
	backgroundSessionSwapInFlight,
	beginBackgroundSessionSwap,
} from "$lib/api/background-session-swap";
import { fetchRest } from "$lib/api/transport";
import { toBase64 } from "$lib/util/base64";

function rejectNotSignedIn() {
	invokeMock.mockRejectedValueOnce({
		kind: "NotSignedIn",
		message: "not signed in",
	});
}

describe("background session swap guard", () => {
	it("is released by its handle, even nested", () => {
		expect(backgroundSessionSwapInFlight()).toBe(false);
		const outer = beginBackgroundSessionSwap();
		const inner = beginBackgroundSessionSwap();
		expect(backgroundSessionSwapInFlight()).toBe(true);
		inner();
		expect(backgroundSessionSwapInFlight()).toBe(true);
		inner();
		expect(backgroundSessionSwapInFlight()).toBe(true);
		outer();
		expect(backgroundSessionSwapInFlight()).toBe(false);
	});

	it("still signs out for a genuine lost session", async () => {
		callMethodMock
			.mockReset()
			.mockResolvedValue({
				profileId: null,
				expiresAt: null,
				stale: false,
			});
		signOutMock.mockReset().mockResolvedValue(undefined);
		rejectNotSignedIn();

		await expect(fetchRest("/v4/cascade")).rejects.toMatchObject({
			kind: "NotSignedIn",
		});
		await vi.waitFor(() => {
			expect(signOutMock).toHaveBeenCalledOnce();
		});
	});

	it("does not sign out for NotSignedIn while a scan owns the session", async () => {
		callMethodMock
			.mockReset()
			.mockResolvedValue({
				profileId: null,
				expiresAt: null,
				stale: false,
			});
		signOutMock.mockReset().mockResolvedValue(undefined);
		rejectNotSignedIn();

		const endSwap = beginBackgroundSessionSwap();
		try {
			await expect(fetchRest("/v4/cascade")).rejects.toMatchObject({
				kind: "NotSignedIn",
			});
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(signOutMock).not.toHaveBeenCalled();
		} finally {
			endSwap();
		}
	});

	it("waits for the swap to settle and retries the request once", async () => {
		callMethodMock
			.mockReset()
			.mockResolvedValue({
				profileId: null,
				expiresAt: null,
				stale: false,
			});
		signOutMock.mockReset().mockResolvedValue(undefined);
		let rejectFirst!: (error: unknown) => void;
		invokeMock.mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					rejectFirst = reject;
				}),
		);
		invokeMock.mockImplementationOnce(() =>
			Promise.resolve(
				toBase64(
					encode({
						status: 200,
						body: new TextEncoder().encode("null"),
					}),
				),
			),
		);

		const pending = fetchRest("/v4/cascade");
		const endSwap = beginBackgroundSessionSwap();
		rejectFirst({ kind: "NotSignedIn", message: "not signed in" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		endSwap();

		const response = await pending;
		expect(response.status).toBe(200);
		expect(signOutMock).not.toHaveBeenCalled();
	});
});
