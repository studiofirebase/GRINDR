import { cleanup, render } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { restoreStrandedLocationMock, scanUnreadAutomaticRepliesMock } =
	vi.hoisted(() => ({
		restoreStrandedLocationMock: vi.fn<() => Promise<void>>(),
		scanUnreadAutomaticRepliesMock:
			vi.fn<(profileId: number) => Promise<void>>(),
	}));

vi.mock("$lib/entitlements/honduras-hold", () => ({
	restoreStrandedLocation: restoreStrandedLocationMock,
}));
vi.mock("$lib/chat/automatic-replies", () => ({
	scanUnreadAutomaticRepliesAtStartup: scanUnreadAutomaticRepliesMock,
}));
vi.mock("$lib/presence/online-heartbeat", () => ({
	startOnlineHeartbeat: () => () => {},
}));
vi.mock("$lib/util/media-retry-signals", () => ({
	retryBrokenMediaWhenOnline: () => () => {},
}));
vi.mock("$lib/components/command-center/CommandCenter.svelte", () => ({
	default: () => {},
}));

import ProtectedLayout from "./+layout.svelte";

const children = createRawSnippet(() => ({ render: () => "<p>page</p>" }));

beforeEach(() => {
	vi.clearAllMocks();
	scanUnreadAutomaticRepliesMock.mockResolvedValue(undefined);
});

afterEach(() => {
	cleanup();
});

describe("(protected) layout", () => {
	it("checks saved profiles before restoring the home location", async () => {
		restoreStrandedLocationMock.mockResolvedValue(undefined);

		render(ProtectedLayout, {
			props: { children, data: { ourProfileId: 42 }, params: {} },
		});

		await vi.waitFor(() =>
			expect(restoreStrandedLocationMock).toHaveBeenCalledOnce(),
		);
		expect(scanUnreadAutomaticRepliesMock).toHaveBeenCalledExactlyOnceWith(
			42,
		);
	});

	it("logs a repair that fails instead of leaving it unhandled", async () => {
		const failure = new Error("offline");
		restoreStrandedLocationMock.mockRejectedValue(failure);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		render(ProtectedLayout, {
			props: { children, data: { ourProfileId: 42 }, params: {} },
		});

		await vi.waitFor(() =>
			expect(consoleError).toHaveBeenCalledWith(
				"Could not move back from Honduras",
				failure,
			),
		);
		consoleError.mockRestore();
	});
});
