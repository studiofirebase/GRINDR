import { beforeEach, describe, expect, it, vi } from "vitest";

const { callMethod } = vi.hoisted(() => ({ callMethod: vi.fn() }));

vi.mock("$lib/api/methods", () => ({ callMethod }));

import { createAccount } from "$lib/api/registration/account";

beforeEach(() => {
	vi.clearAllMocks();
	callMethod.mockResolvedValue({
		profileId: "42",
		verificationRequired: true,
	});
});

describe("account creation", () => {
	it("creates the account with the sign-up details", async () => {
		const result = await createAccount({
			email: "new@example.com",
			password: "s3cret!",
			dateOfBirth: 1_234_567_890_000,
			captchaToken: "captcha-xyz",
		});

		expect(callMethod).toHaveBeenCalledExactlyOnceWith("create_account", {
			email: "new@example.com",
			password: "s3cret!",
			dateOfBirth: 1_234_567_890_000,
			captchaToken: "captcha-xyz",
		});
		expect(result).toEqual({ profileId: "42", verificationRequired: true });
	});

	it("passes the captcha token through only when minted", async () => {
		await createAccount({
			email: "new@example.com",
			password: "s3cret!",
			dateOfBirth: 1_234_567_890_000,
		});

		expect(callMethod).toHaveBeenCalledExactlyOnceWith("create_account", {
			email: "new@example.com",
			password: "s3cret!",
			dateOfBirth: 1_234_567_890_000,
			captchaToken: undefined,
		});
	});
});
