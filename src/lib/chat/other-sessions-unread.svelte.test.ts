// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	callMethodMock,
	getConversationsMock,
	toastInfoMock,
	notifyMock,
	isTauriMock,
	isDesktopMock,
	scanRepliesMock,
} = vi.hoisted(() => ({
	callMethodMock: vi.fn(),
	getConversationsMock: vi.fn(),
	toastInfoMock: vi.fn(),
	notifyMock: vi.fn(),
	isTauriMock: vi.fn(() => true),
	isDesktopMock: vi.fn(() => true),
	scanRepliesMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: isTauriMock }));
vi.mock("$lib/api/methods", () => ({ callMethod: callMethodMock }));
vi.mock("$lib/api/messaging/conversations", () => ({
	getConversations: getConversationsMock,
}));
vi.mock("$lib/demo", () => ({ demoEnabled: false }));
vi.mock("$lib/web/bridge", () => ({ webBackendEnabled: false }));
vi.mock("$lib/push", () => ({ notify: notifyMock }));
vi.mock("$lib/platform/os", () => ({ isDesktopPlatform: isDesktopMock }));
vi.mock("$lib/chat/automatic-replies", () => ({
	scanUnreadAutomaticRepliesForProfile: scanRepliesMock,
}));
vi.mock("svelte-sonner", () => ({ toast: { info: toastInfoMock } }));

import { backgroundSessionSwapInFlight } from "$lib/api/background-session-swap";
import {
	liveBackgroundState,
	noteLiveBackgroundMessage,
	otherSessionsUnread,
	refreshOtherSessionsUnread,
} from "./other-sessions-unread.svelte";

const startingSession = { profileId: 42, expiresAt: null, stale: false };

function inbox(unreadCounts: number[], nextPage: number | null = null) {
	return {
		entries: unreadCounts.map((unreadCount, index) => ({
			data: { conversationId: `c${index}`, unreadCount },
		})),
		nextPage,
	};
}

function savedProfiles() {
	return [
		{ profileId: "42", name: "one@example.com", active: true },
		{ profileId: "43", name: "two@example.com", active: false },
	];
}

let activeProfileId = "42";

beforeEach(() => {
	vi.unstubAllGlobals();
	activeProfileId = "42";
	callMethodMock
		.mockReset()
		.mockImplementation((method: string, data?: { profileId?: string }) => {
			if (method === "current_session")
				return Promise.resolve({
					...startingSession,
					profileId: Number(activeProfileId),
				});
			if (method === "profile_list")
				return Promise.resolve(savedProfiles());
			if (
				(method === "profile_switch" ||
					method === "profile_scan_switch") &&
				data?.profileId
			) {
				activeProfileId = data.profileId;
				return Promise.resolve(null);
			}
			return Promise.resolve(null);
		});
	getConversationsMock.mockReset().mockResolvedValue(inbox([2, 1]));
	toastInfoMock.mockReset();
	notifyMock.mockReset().mockResolvedValue(undefined);
	isTauriMock.mockReset().mockReturnValue(true);
	isDesktopMock.mockReset().mockReturnValue(true);
	scanRepliesMock.mockReset().mockResolvedValue(undefined);
	otherSessionsUnread.resetForTesting();
});

describe("other sessions unread", () => {
	it("records unread totals for inactive profiles and skips the active one", async () => {
		await refreshOtherSessionsUnread();

		expect(otherSessionsUnread.unreadFor("43")).toBe(3);
		expect(otherSessionsUnread.unreadFor("42")).toBe(0);
		expect(otherSessionsUnread.total).toBe(3);
	});

	it("switches back to the starting profile after scanning", async () => {
		await refreshOtherSessionsUnread();

		const switches = callMethodMock.mock.calls.filter(
			([method]) => method === "profile_switch",
		);
		expect(switches.at(-1)).toEqual([
			"profile_switch",
			{ profileId: "42" },
		]);
	});

	it("borrows sessions quietly and restores loudly", async () => {
		await refreshOtherSessionsUnread({ notify: false });

		const switches = callMethodMock.mock.calls.filter(
			([method]) =>
				method === "profile_scan_switch" || method === "profile_switch",
		);
		expect(switches).toEqual([
			["profile_scan_switch", { profileId: "43" }],
			["profile_switch", { profileId: "42" }],
		]);
	});

	it("brings the backend to the session the user picked mid-scan", async () => {
		getConversationsMock.mockImplementationOnce(() => {
			// The user switches away while the scan is borrowing the session.
			activeProfileId = "44";
			return Promise.resolve(inbox([2, 1]));
		});
		await refreshOtherSessionsUnread({ notify: false });

		expect(callMethodMock).toHaveBeenCalledWith("profile_scan_switch", {
			profileId: "43",
		});
		expect(callMethodMock).toHaveBeenCalledWith("profile_switch", {
			profileId: "44",
		});
		expect(callMethodMock).not.toHaveBeenCalledWith("profile_switch", {
			profileId: "42",
		});
	});

	it("runs automatic replies on sessions with newly seen unread", async () => {
		await refreshOtherSessionsUnread();
		expect(scanRepliesMock).toHaveBeenCalledWith(43);

		scanRepliesMock.mockClear();
		await refreshOtherSessionsUnread();
		expect(scanRepliesMock).not.toHaveBeenCalled();

		getConversationsMock.mockResolvedValue(inbox([4, 1]));
		await refreshOtherSessionsUnread();
		expect(scanRepliesMock).toHaveBeenCalledWith(43);
	});

	it("skips automatic replies when there is nothing unread", async () => {
		getConversationsMock.mockResolvedValue(inbox([0, 0]));
		await refreshOtherSessionsUnread();

		expect(scanRepliesMock).not.toHaveBeenCalled();
		expect(otherSessionsUnread.total).toBe(0);
	});

	it("holds the swap guard across every backend session switch", async () => {
		const guardDuringSwitch: boolean[] = [];
		callMethodMock.mockImplementation(
			(method: string, data?: { profileId?: string }) => {
				if (method === "current_session")
					return Promise.resolve({
						...startingSession,
						profileId: Number(activeProfileId),
					});
				if (method === "profile_list")
					return Promise.resolve(savedProfiles());
				if (
					(method === "profile_switch" ||
						method === "profile_scan_switch") &&
					data?.profileId
				) {
					guardDuringSwitch.push(backgroundSessionSwapInFlight());
					activeProfileId = data.profileId;
					return Promise.resolve(null);
				}
				return Promise.resolve(null);
			},
		);

		await refreshOtherSessionsUnread();

		expect(guardDuringSwitch.length).toBeGreaterThan(0);
		expect(guardDuringSwitch.every((held) => held)).toBe(true);
		expect(backgroundSessionSwapInFlight()).toBe(false);
	});

	it("opens a floating balloon with the message on increases", async () => {
		getConversationsMock.mockResolvedValue({
			entries: [
				{
					data: {
						conversationId: "c0",
						unreadCount: 2,
						name: "Alex",
						participants: [{ primaryMediaHash: "alex-avatar" }],
						preview: { type: "Text", text: "hey there" },
					},
				},
				{ data: { conversationId: "c1", unreadCount: 1 } },
			],
			nextPage: null,
		});
		await refreshOtherSessionsUnread();
		expect(callMethodMock).not.toHaveBeenCalledWith(
			"bubble_show",
			expect.anything(),
		);
		expect(notifyMock).not.toHaveBeenCalled();
		expect(toastInfoMock).not.toHaveBeenCalled();

		await refreshOtherSessionsUnread();
		expect(callMethodMock).not.toHaveBeenCalledWith(
			"bubble_show",
			expect.anything(),
		);

		getConversationsMock.mockResolvedValue({
			entries: [
				{
					data: {
						conversationId: "c0",
						unreadCount: 4,
						name: "Alex",
						participants: [{ primaryMediaHash: "alex-avatar" }],
						preview: { type: "Text", text: "hey there" },
					},
				},
				{ data: { conversationId: "c1", unreadCount: 1 } },
			],
			nextPage: null,
		});
		await refreshOtherSessionsUnread();
		expect(callMethodMock).toHaveBeenCalledWith("bubble_show", {
			profileId: "43",
			profileName: "two@example.com",
			conversationId: "c0",
			peerName: "Alex",
			peerAvatarMediaHash: "alex-avatar",
			snippet: "hey there",
			unread: 5,
		});
		expect(notifyMock).not.toHaveBeenCalled();
		expect(toastInfoMock).not.toHaveBeenCalled();
	});

	it("falls back to a system notification when the balloon fails", async () => {
		callMethodMock.mockImplementation(
			(method: string, data?: { profileId?: string }) => {
				if (method === "current_session")
					return Promise.resolve({
						...startingSession,
						profileId: Number(activeProfileId),
					});
				if (method === "profile_list")
					return Promise.resolve(savedProfiles());
				if (
					(method === "profile_switch" ||
						method === "profile_scan_switch") &&
					data?.profileId
				) {
					activeProfileId = data.profileId;
					return Promise.resolve(null);
				}
				if (method === "bubble_show")
					return Promise.reject(new Error("no window support"));
				return Promise.resolve(null);
			},
		);
		await refreshOtherSessionsUnread();
		getConversationsMock.mockResolvedValue(inbox([4, 1]));
		await refreshOtherSessionsUnread();

		expect(notifyMock).toHaveBeenCalledOnce();
		expect(notifyMock.mock.calls[0]?.[0]?.tag).toBe("other-session:43");
		expect(toastInfoMock).not.toHaveBeenCalled();
	});

	it("falls back to an in-app toast where there is no system overlay", async () => {
		isDesktopMock.mockReturnValue(false);

		await refreshOtherSessionsUnread();
		getConversationsMock.mockResolvedValue(inbox([4, 1]));
		await refreshOtherSessionsUnread();

		expect(notifyMock).not.toHaveBeenCalled();
		expect(toastInfoMock).toHaveBeenCalledOnce();
		expect(toastInfoMock.mock.calls[0]?.[0]).toContain("two@example.com");
	});

	it("keeps the previous count when a profile scan fails", async () => {
		await refreshOtherSessionsUnread();
		expect(otherSessionsUnread.unreadFor("43")).toBe(3);

		getConversationsMock.mockRejectedValue(new Error("offline"));
		await refreshOtherSessionsUnread();

		expect(otherSessionsUnread.unreadFor("43")).toBe(3);
	});

	it("does nothing when there is no backend to talk to", async () => {
		isTauriMock.mockReturnValue(false);

		await refreshOtherSessionsUnread();

		expect(callMethodMock).not.toHaveBeenCalled();
		expect(otherSessionsUnread.total).toBe(0);
	});

	it("balloons a live background message and answers it once", async () => {
		noteLiveBackgroundMessage({
			profileId: "43",
			profileName: "two@example.com",
			conversationId: "c0",
			snippet: "hey, are you there?",
		});

		// The badge bumps immediately, before any session switch.
		expect(otherSessionsUnread.unreadFor("43")).toBe(1);
		expect(callMethodMock).toHaveBeenCalledWith("bubble_show", {
			profileId: "43",
			profileName: "two@example.com",
			conversationId: "c0",
			peerName: "Someone",
			peerAvatarMediaHash: null,
			snippet: "hey, are you there?",
			unread: 1,
		});
		expect(liveBackgroundState.lastBalloonAt).not.toBeNull();

		// The queued single-profile sync answers the unread, restores the
		// visible session, and marks the total so a later scan at the same
		// total stays quiet.
		await vi.waitFor(() => {
			expect(scanRepliesMock).toHaveBeenCalledWith(43);
			expect(backgroundSessionSwapInFlight()).toBe(false);
		});
		expect(otherSessionsUnread.unreadFor("43")).toBe(3);
		const switches = callMethodMock.mock.calls.filter(
			([method]) => method === "profile_switch",
		);
		expect(switches.at(-1)).toEqual([
			"profile_switch",
			{ profileId: "42" },
		]);

		getConversationsMock.mockResolvedValue(inbox([2, 1]));
		const notifyBefore = notifyMock.mock.calls.length;
		await refreshOtherSessionsUnread();
		expect(notifyMock.mock.calls.length).toBe(notifyBefore);
		expect(scanRepliesMock).toHaveBeenCalledTimes(1);
	});

	it("coalesces back-to-back live messages into one sync", async () => {
		noteLiveBackgroundMessage({ profileId: "43", snippet: "one" });
		noteLiveBackgroundMessage({ profileId: "43", snippet: "two" });

		expect(otherSessionsUnread.unreadFor("43")).toBe(2);
		await vi.waitFor(() => {
			expect(scanRepliesMock).toHaveBeenCalledWith(43);
			expect(backgroundSessionSwapInFlight()).toBe(false);
		});
		expect(scanRepliesMock).toHaveBeenCalledTimes(1);
	});

	it("uses the last scanned peer name for live balloons", async () => {
		getConversationsMock.mockResolvedValue({
			entries: [
				{
					data: {
						conversationId: "c0",
						unreadCount: 2,
						name: "Alex",
						participants: [{ primaryMediaHash: "alex-avatar" }],
						preview: { type: "Text", text: "hey there" },
					},
				},
			],
			nextPage: null,
		});
		await refreshOtherSessionsUnread({ notify: false });

		noteLiveBackgroundMessage({ profileId: "43" });

		expect(callMethodMock).toHaveBeenCalledWith(
			"bubble_show",
			expect.objectContaining({
				profileId: "43",
				profileName: "two@example.com",
				peerName: "Alex",
				snippet: "hey there",
				unread: 3,
				peerAvatarMediaHash: "alex-avatar",
				conversationId: "c0",
			}),
		);

		// Let the queued sync reconcile before the next test.
		await vi.waitFor(() => {
			expect(backgroundSessionSwapInFlight()).toBe(false);
			expect(otherSessionsUnread.unreadFor("43")).toBe(2);
		});
	});
});
