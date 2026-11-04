// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { openExternalLink, platform } = vi.hoisted(() => ({
	openExternalLink: vi.fn(),
	platform: { isAndroidPlatform: vi.fn(() => false) },
}));

vi.mock("$lib/platform/link-opener", () => ({ openExternalLink }));
vi.mock("$lib/platform/os", () => platform);

const PLAY_STORE_URL =
	"https://play.google.com/store/apps/details?id=com.grindrapp.android";
const DOWNLOAD_URL = "https://www.grindr.com/download";

let testing: typeof import("@testing-library/svelte");

async function opened() {
	testing = await import("@testing-library/svelte");
	const { default: RegisterForm } = await import("./RegisterForm.svelte");
	testing.render(RegisterForm);
	await new Promise((resolve) => setTimeout(resolve, 0));
	return testing;
}

describe("RegisterForm", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		platform.isAndroidPlatform.mockReturnValue(false);
	});

	afterEach(() => {
		testing?.cleanup();
	});

	it("says accounts can only be created in the official app", async () => {
		const { screen } = await opened();

		expect(
			screen.getByText(/can only be created in the official Grindr app/),
		).toBeTruthy();
		expect(
			screen.getByText(/does not register accounts via web/),
		).toBeTruthy();
	});

	it("opens the official download page outside Android", async () => {
		const { screen, fireEvent } = await opened();

		await fireEvent.click(
			screen.getByRole("button", { name: "Get the official Grindr app" }),
		);

		expect(openExternalLink).toHaveBeenCalledExactlyOnceWith(DOWNLOAD_URL);
		expect(
			screen.queryByRole("button", { name: "Other download options" }),
		).toBeNull();
	});

	it("opens the Play Store on Android and keeps the download page as fallback", async () => {
		platform.isAndroidPlatform.mockReturnValue(true);
		const { screen, fireEvent } = await opened();

		await fireEvent.click(
			screen.getByRole("button", { name: "Get the official Grindr app" }),
		);
		expect(openExternalLink).toHaveBeenCalledExactlyOnceWith(
			PLAY_STORE_URL,
		);

		await fireEvent.click(
			screen.getByRole("button", { name: "Other download options" }),
		);
		expect(openExternalLink).toHaveBeenNthCalledWith(2, DOWNLOAD_URL);
	});

	it("links back to sign-in", async () => {
		const { screen } = await opened();

		expect(
			screen.getByRole("link", {
				name: "I already registered — Sign In",
			}),
		).toHaveProperty("href", expect.stringContaining("/auth/sign-in"));
	});
});
