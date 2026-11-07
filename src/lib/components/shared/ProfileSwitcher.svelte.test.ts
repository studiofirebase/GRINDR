// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	getPreferences,
	setPreferences,
} from "$lib/app-data/preferences.svelte";
import ProfileSwitcher from "./ProfileSwitcher.svelte";

vi.mock("$app/navigation", () => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("$lib/api/background-session-swap", () => ({
	backgroundSessionSwapInFlight: () => false,
	awaitBackgroundSwapEnd: () => Promise.resolve(true),
}));
vi.mock("$lib/api/account-caches", () => ({ clearAccountCaches: vi.fn() }));
vi.mock("$lib/chat/other-sessions-unread.svelte", () => ({
	otherSessionsUnread: { total: 0, unreadFor: () => 0 },
	refreshOtherSessionsUnread: () => Promise.resolve(),
}));
vi.mock("$lib/chat/secondary-sessions.svelte", () => ({
	secondarySessions: { isOnline: () => false },
	refreshSecondaryStatus: () => Promise.resolve(),
}));
vi.mock("$lib/demo", () => ({ demoEnabled: false }));
vi.mock("$lib/web/bridge", () => ({
	webBackendEnabled: false,
	adminMe: vi.fn(),
	adminLogout: vi.fn(),
	openCreateAdminDialog: vi.fn(),
}));

const switchCalls: Array<Record<string, unknown>> = [];
let profileList: Array<{ profileId: string; name: string; active: boolean }> =
	[];

vi.mock("$lib/api/methods", () => ({
	callMethod: vi.fn((method: string, args?: Record<string, unknown>) => {
		if (method === "profile_list") return Promise.resolve(profileList);
		if (method === "current_session") {
			return Promise.resolve({
				profileId: null,
				expiresAt: null,
				stale: false,
			});
		}
		if (method === "profile_switch") {
			switchCalls.push({ ...(args ?? {}) });
			return Promise.resolve("u4pruydqqvkp");
		}
		return Promise.resolve(null);
	}),
}));

const CURRENT_GEOHASH = "u4pruydqqvj8";
const TARGET_GEOHASH = "u4pruydqqvkp";

beforeEach(() => {
	localStorage.clear();
	switchCalls.length = 0;
	profileList = [
		{ profileId: "a", name: "Alpha", active: true },
		{ profileId: "b", name: "Beta", active: false },
	];
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("ProfileSwitcher location", () => {
	it("sends the current location when switching and restores the target one", async () => {
		await setPreferences({ geohash: CURRENT_GEOHASH });

		render(ProfileSwitcher);
		await fireEvent.click(
			screen.getByRole("button", { name: /switch profile/i }),
		);
		await fireEvent.click(await screen.findByText("Beta"));

		await vi.waitFor(() => {
			expect(switchCalls).toHaveLength(1);
		});
		expect(switchCalls[0]).toEqual({
			profileId: "b",
			geohash: CURRENT_GEOHASH,
		});
		expect((await getPreferences()).geohash).toBe(TARGET_GEOHASH);
	});
});
