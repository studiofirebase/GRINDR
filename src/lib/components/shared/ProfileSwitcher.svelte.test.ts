// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	callMethodMock,
	clearAccountCachesMock,
	clearAccountPreferencesMock,
	gotoMock,
	setPreferencesMock,
	refreshOtherSessionsUnreadMock,
	otherSessionsUnreadState,
	listenMock,
} = vi.hoisted(() => ({
	callMethodMock: vi.fn(),
	clearAccountCachesMock: vi.fn(),
	clearAccountPreferencesMock: vi.fn(),
	gotoMock: vi.fn(),
	setPreferencesMock: vi.fn(),
	refreshOtherSessionsUnreadMock: vi.fn(),
	otherSessionsUnreadState: {
		total: 0,
		unreadFor: (profileId: string): number => {
			void profileId;
			return 0;
		},
	},
	listenMock: vi.fn<
		(
			event: string,
			handler: (event: {
				payload: { profileId: string; profileName: string };
			}) => void,
		) => Promise<() => void>
	>(() => Promise.resolve(() => {})),
}));

vi.mock("$app/navigation", () => ({ goto: gotoMock }));
vi.mock("$lib/api/methods", () => ({ callMethod: callMethodMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("$lib/chat/other-sessions-unread.svelte", () => ({
	otherSessionsUnread: otherSessionsUnreadState,
	refreshOtherSessionsUnread: refreshOtherSessionsUnreadMock,
}));
vi.mock("$lib/api/account-caches", () => ({
	clearAccountCaches: clearAccountCachesMock,
}));
vi.mock("$lib/app-data/preferences.svelte", () => ({
	clearAccountPreferences: clearAccountPreferencesMock,
	setPreferences: setPreferencesMock,
}));
vi.mock("$lib/demo", () => ({ demoEnabled: false }));

import ProfileSwitcher from "./ProfileSwitcher.svelte";

beforeEach(() => {
	callMethodMock.mockReset().mockResolvedValue([]);
	clearAccountCachesMock.mockReset();
	clearAccountPreferencesMock.mockReset();
	gotoMock.mockReset();
	setPreferencesMock.mockReset();
	refreshOtherSessionsUnreadMock.mockReset().mockResolvedValue(undefined);
	otherSessionsUnreadState.total = 0;
	otherSessionsUnreadState.unreadFor = (profileId: string): number => {
		void profileId;
		return 0;
	};
	listenMock.mockReset().mockResolvedValue(() => {});
});

afterEach(() => cleanup());

describe("profile switcher", () => {
	it("switches to the chosen saved profile and reloads account data", async () => {
		callMethodMock.mockImplementation((method: string, data?: unknown) => {
			if (method === "profile_list")
				return [
					{ profileId: "42", name: "one@example.com", active: true },
					{ profileId: "43", name: "two@example.com", active: false },
				];
			if (method === "current_session")
				return { profileId: 42, expiresAt: null, stale: false };
			if (
				method === "profile_switch" &&
				(data as { profileId?: string })?.profileId === "43"
			)
				return "u33dc1c1f1s0";
			return null;
		});
		render(ProfileSwitcher);

		await fireEvent.click(
			await screen.findByRole("button", { name: "Switch profile" }),
		);
		await fireEvent.click(await screen.findByText("two@example.com"));

		await vi.waitFor(() => {
			expect(callMethodMock).toHaveBeenCalledWith("profile_switch", {
				profileId: "43",
			});
			expect(clearAccountCachesMock).toHaveBeenCalledOnce();
			expect(clearAccountPreferencesMock).toHaveBeenCalledOnce();
			expect(setPreferencesMock).toHaveBeenCalledWith({
				geohash: "u33dc1c1f1s0",
			});
			expect(gotoMock).toHaveBeenCalledWith("/", { invalidateAll: true });
		});
	});

	it("starts adding an account while preserving the saved profiles", async () => {
		callMethodMock.mockImplementation((method: string) => {
			if (method === "profile_list")
				return [
					{ profileId: "42", name: "one@example.com", active: true },
				];
			if (method === "current_session")
				return { profileId: 42, expiresAt: null, stale: false };
			return null;
		});
		render(ProfileSwitcher);

		await fireEvent.click(
			await screen.findByRole("button", { name: "Switch profile" }),
		);
		await fireEvent.click(await screen.findByText("Add another account"));

		await vi.waitFor(() => {
			expect(callMethodMock).toHaveBeenCalledWith("profile_add");
			expect(clearAccountCachesMock).toHaveBeenCalledOnce();
			expect(clearAccountPreferencesMock).toHaveBeenCalledOnce();
			expect(gotoMock).toHaveBeenCalledWith("/auth/sign-in");
		});
	});

	it("shows disconnect for the current session when the saved list is empty", async () => {
		callMethodMock.mockImplementation((method: string) => {
			if (method === "profile_list") return [];
			if (method === "current_session")
				return { profileId: 42, expiresAt: null, stale: false };
			return null;
		});
		render(ProfileSwitcher);

		await fireEvent.click(
			await screen.findByRole("button", { name: "Switch profile" }),
		);

		await screen.findByText("Disconnect current profile");
	});

	it("disconnects the current session when no saved profiles exist", async () => {
		callMethodMock.mockImplementation((method: string) => {
			if (method === "profile_list") return [];
			if (method === "current_session")
				return { profileId: 42, expiresAt: null, stale: false };
			return null;
		});
		render(ProfileSwitcher);

		await fireEvent.click(
			await screen.findByRole("button", { name: "Switch profile" }),
		);
		await fireEvent.click(
			await screen.findByText("Disconnect current profile"),
		);

		await vi.waitFor(() => {
			expect(callMethodMock).toHaveBeenCalledWith("sign_out");
			expect(clearAccountCachesMock).toHaveBeenCalledOnce();
			expect(clearAccountPreferencesMock).toHaveBeenCalledOnce();
			expect(gotoMock).toHaveBeenCalledWith("/auth/sign-in");
		});
	});

	it("switches sessions when the floating balloon asks to open one", async () => {
		let openHandler: (event: {
			payload: { profileId: string; profileName: string };
		}) => void = () => {};
		listenMock.mockImplementation(
			(event: string, handler: typeof openHandler) => {
				void event;
				openHandler = handler;
				return Promise.resolve(() => {});
			},
		);
		callMethodMock.mockImplementation((method: string) => {
			if (method === "profile_list")
				return [
					{ profileId: "42", name: "one@example.com", active: true },
					{ profileId: "43", name: "two@example.com", active: false },
				];
			if (method === "current_session")
				return { profileId: 42, expiresAt: null, stale: false };
			return "u33dc1c1f1s0";
		});
		render(ProfileSwitcher);

		await vi.waitFor(() => {
			expect(listenMock).toHaveBeenCalledWith(
				"bubble:open-profile",
				expect.any(Function),
			);
		});
		openHandler({
			payload: { profileId: "43", profileName: "two@example.com" },
		});

		await vi.waitFor(() => {
			expect(callMethodMock).toHaveBeenCalledWith("profile_switch", {
				profileId: "43",
			});
			expect(gotoMock).toHaveBeenCalledWith("/", { invalidateAll: true });
		});
	});

	it("shows an unread balloon for other sessions on the button and rows", async () => {
		otherSessionsUnreadState.total = 3;
		otherSessionsUnreadState.unreadFor = (profileId: string): number =>
			profileId === "43" ? 3 : 0;
		callMethodMock.mockImplementation((method: string) => {
			if (method === "profile_list")
				return [
					{ profileId: "42", name: "one@example.com", active: true },
					{ profileId: "43", name: "two@example.com", active: false },
				];
			if (method === "current_session")
				return { profileId: 42, expiresAt: null, stale: false };
			return null;
		});
		render(ProfileSwitcher);

		await fireEvent.click(
			await screen.findByRole("button", { name: "Switch profile" }),
		);

		const balloons = await screen.findAllByText("3");
		expect(balloons).toHaveLength(2);
		expect(refreshOtherSessionsUnreadMock).toHaveBeenCalledWith({
			notify: false,
		});
	});
});
