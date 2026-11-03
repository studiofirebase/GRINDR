import { beforeEach, describe, expect, it, vi } from "vitest";

const { callMethodMock, isTauriMock, writeAppDataFileAtomicMock } = vi.hoisted(
	() => ({
		callMethodMock: vi.fn(),
		isTauriMock: vi.fn(),
		writeAppDataFileAtomicMock: vi.fn(),
	}),
);

vi.mock("@tauri-apps/api/core", () => ({ isTauri: isTauriMock }));
vi.mock("$lib/api/methods", () => ({ callMethod: callMethodMock }));
vi.mock("$lib/demo", () => ({ demoEnabled: false }));
vi.mock("./index", () => ({
	existsAppDataFile: vi.fn(() => Promise.resolve(false)),
	readAppDataFile: vi.fn(),
	removeAppDataFile: vi.fn(),
	writeAppDataFileAtomic: writeAppDataFileAtomicMock,
}));

import {
	claimAutomaticReply,
	clearAccountPreferences,
	enableAutomaticRepliesForProfiles,
	enableAutomaticRepliesForUnconfiguredProfiles,
	getAutomaticReplySettings,
	releaseAutomaticReplyClaim,
	setAutomaticReplySettings,
	setPreferences,
} from "./preferences.svelte";

beforeEach(() => {
	isTauriMock.mockReset().mockReturnValue(true);
	callMethodMock.mockReset().mockResolvedValue(null);
	writeAppDataFileAtomicMock.mockReset().mockResolvedValue(undefined);
});

describe("profile-scoped location preference", () => {
	it("persists a chosen location to the active profile in Tauri", async () => {
		await setPreferences({ geohash: "u33dc1c1f1s0" });

		expect(callMethodMock).toHaveBeenCalledWith("profile_set_location", {
			geohash: "u33dc1c1f1s0",
		});

		expect(writeAppDataFileAtomicMock).toHaveBeenCalledOnce();
	});

	it("does not invoke profile storage in the browser", async () => {
		isTauriMock.mockReturnValue(false);

		await setPreferences({ geohash: "u33dc1c1f1s0" });

		expect(callMethodMock).not.toHaveBeenCalled();
		expect(writeAppDataFileAtomicMock).toHaveBeenCalledOnce();
	});
});

describe("profile-scoped automatic replies", () => {
	it("defaults off and persists settings and durable message claims per profile", async () => {
		expect(await getAutomaticReplySettings(42)).toEqual({
			enabled: false,
			includeDrawerMedia: false,
			instructions: "",
			provider: "openrouter",
			revision: 0,
		});

		await setAutomaticReplySettings(42, {
			enabled: true,
			includeDrawerMedia: true,
			instructions: "Be friendly",
			provider: "openrouter",
		});

		expect(await getAutomaticReplySettings(42)).toMatchObject({
			enabled: true,
			includeDrawerMedia: true,
			instructions: "Be friendly",
			provider: "openrouter",
		});
		expect(await getAutomaticReplySettings(43)).toMatchObject({
			enabled: false,
			provider: "openrouter",
		});
		await expect(claimAutomaticReply(42, "message-1", 0)).resolves.toBe(
			false,
		);
		await expect(claimAutomaticReply(42, "message-1", 1)).resolves.toBe(
			true,
		);
		await expect(claimAutomaticReply(42, "message-1")).resolves.toBe(false);
		await expect(
			releaseAutomaticReplyClaim(42, "message-1", 1),
		).resolves.toBe(true);
		await expect(claimAutomaticReply(42, "message-1", 1)).resolves.toBe(
			true,
		);
		await expect(
			releaseAutomaticReplyClaim(42, "message-1", 0),
		).resolves.toBe(false);
		expect(writeAppDataFileAtomicMock).toHaveBeenCalled();
	});

	it("enables every saved profile and preserves each profile's settings", async () => {
		await setAutomaticReplySettings(42, {
			enabled: false,
			includeDrawerMedia: true,
			instructions: "Current profile directions",
		});
		await setAutomaticReplySettings(43, {
			enabled: false,
			includeDrawerMedia: true,
			instructions: "Other profile directions",
			provider: "apple-intelligence",
		});
		writeAppDataFileAtomicMock.mockClear();

		await enableAutomaticRepliesForProfiles([42, 43, 42], {
			profileId: 42,
			includeDrawerMedia: false,
			instructions: "Updated current directions",
		});

		expect(await getAutomaticReplySettings(42)).toMatchObject({
			enabled: true,
			includeDrawerMedia: false,
			instructions: "Updated current directions",
		});
		expect(await getAutomaticReplySettings(43)).toMatchObject({
			enabled: true,
			includeDrawerMedia: true,
			instructions: "Other profile directions",
			provider: "apple-intelligence",
		});
		expect(writeAppDataFileAtomicMock).toHaveBeenCalledOnce();
	});

	it("enables only profiles without a saved automatic-reply choice", async () => {
		await setAutomaticReplySettings(91_001, {
			enabled: false,
			includeDrawerMedia: true,
			instructions: "Keep replies disabled",
		});
		writeAppDataFileAtomicMock.mockClear();

		await enableAutomaticRepliesForUnconfiguredProfiles([
			91_001, 91_002, 91_002,
		]);

		expect(await getAutomaticReplySettings(91_001)).toMatchObject({
			enabled: false,
			instructions: "Keep replies disabled",
		});
		expect(await getAutomaticReplySettings(91_002)).toMatchObject({
			enabled: true,
			includeDrawerMedia: false,
			instructions: "",
			provider: "openrouter",
			revision: 1,
		});
		expect(writeAppDataFileAtomicMock).toHaveBeenCalledOnce();

		writeAppDataFileAtomicMock.mockClear();
		await enableAutomaticRepliesForUnconfiguredProfiles([91_001, 91_002]);
		expect(writeAppDataFileAtomicMock).not.toHaveBeenCalled();
	});

	it("keeps AI activation when account preferences are cleared on switch", async () => {
		await setAutomaticReplySettings(42, {
			enabled: true,
			includeDrawerMedia: false,
			instructions: "Stay active for this profile",
		});

		await clearAccountPreferences();

		expect(await getAutomaticReplySettings(42)).toMatchObject({
			enabled: true,
			instructions: "Stay active for this profile",
		});
	});
});
