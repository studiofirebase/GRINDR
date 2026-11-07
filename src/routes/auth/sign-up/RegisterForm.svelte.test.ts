// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	callMethod,
	createAccount,
	sendSmsVerificationCode,
	verifySmsCode,
	showErrorToast,
	toast,
	openExternalLink,
	platform,
} = vi.hoisted(() => ({
	callMethod: vi.fn(),
	createAccount: vi.fn(),
	sendSmsVerificationCode: vi.fn(),
	verifySmsCode: vi.fn(),
	showErrorToast: vi.fn(),
	toast: { success: vi.fn() },
	openExternalLink: vi.fn(),
	platform: { isAndroidPlatform: vi.fn(() => false) },
}));

vi.mock("$lib/api/methods", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/api/methods")>()),
	callMethod,
}));
vi.mock("$lib/api/registration/account", () => ({ createAccount }));
vi.mock("$lib/api/registration/sms", () => ({
	sendSmsVerificationCode,
	verifySmsCode,
}));
vi.mock("$lib/api/error-toast", () => ({ showErrorToast }));
vi.mock("svelte-sonner", () => ({ toast }));
vi.mock("$lib/platform/link-opener", () => ({ openExternalLink }));
vi.mock("$lib/platform/os", () => platform);

import RegisterForm from "./RegisterForm.svelte";

const ADULT_BIRTHDATE = "2000-01-01";
const ADULT_MILLIS = Date.parse(`${ADULT_BIRTHDATE}T00:00:00Z`);

function label(name: string | RegExp) {
	return screen.getByLabelText(name);
}

async function fillDetails({
	email = "new@example.com",
	password = "s3cret!",
	birthdate = ADULT_BIRTHDATE,
}: { email?: string; password?: string; birthdate?: string } = {}) {
	await fireEvent.input(label("Email"), { target: { value: email } });
	await fireEvent.input(label("Password"), { target: { value: password } });
	await fireEvent.input(label("Confirm password"), {
		target: { value: password },
	});
	await fireEvent.input(label("Date of birth"), {
		target: { value: birthdate },
	});
}

async function submit() {
	await fireEvent.click(
		screen.getByRole("button", { name: "Create account" }),
	);
}

function opened() {
	render(RegisterForm);
}

beforeEach(() => {
	vi.clearAllMocks();
	platform.isAndroidPlatform.mockReturnValue(false);
	callMethod.mockResolvedValue("captcha-xyz");
	createAccount.mockResolvedValue({
		profileId: "42",
		verificationRequired: true,
	});
	sendSmsVerificationCode.mockResolvedValue({});
	verifySmsCode.mockResolvedValue({});
});

afterEach(() => {
	cleanup();
});

describe("RegisterForm", () => {
	it("collects email, password and date of birth", () => {
		opened();

		expect(label("Email")).toBeTruthy();
		expect(label("Password")).toBeTruthy();
		expect(label("Confirm password")).toBeTruthy();
		expect(label("Date of birth")).toBeTruthy();
		expect(
			screen.getByRole("link", {
				name: "I already registered — Sign In",
			}),
		).toBeTruthy();
	});

	it("refuses mismatched passwords without calling the server", async () => {
		opened();
		await fillDetails();
		await fireEvent.input(label("Confirm password"), {
			target: { value: "different" },
		});
		await submit();

		expect(screen.getByText("Passwords do not match.")).toBeTruthy();
		expect(createAccount).not.toHaveBeenCalled();
	});

	it("refuses underage birthdates without calling the server", async () => {
		const { container } = render(RegisterForm);
		const today = new Date().toISOString().slice(0, 10);
		await fillDetails({ birthdate: today });
		// Dispatch submit directly: the date input's native max already
		// blocks real submits, this exercises the in-form guard.
		const form = container.querySelector("form");
		if (!form) throw new Error("signup form missing");
		await fireEvent.submit(form);

		expect(
			screen.getByText("You must be 18 or older to create an account."),
		).toBeTruthy();
		expect(createAccount).not.toHaveBeenCalled();
	});

	it("creates the account with a captcha token and moves to SMS verification", async () => {
		opened();
		await fillDetails();
		await submit();

		expect(callMethod).toHaveBeenCalledExactlyOnceWith(
			"mint_recaptcha_token",
			{ action: "sign_up" },
		);
		expect(createAccount).toHaveBeenCalledExactlyOnceWith({
			email: "new@example.com",
			password: "s3cret!",
			dateOfBirth: ADULT_MILLIS,
			captchaToken: "captcha-xyz",
		});
		await screen.findByLabelText("Phone number");
	});

	it("creates the account without a token when captcha is unavailable", async () => {
		callMethod.mockRejectedValueOnce(new Error("no helper"));
		opened();
		await fillDetails();
		await submit();

		expect(createAccount).toHaveBeenCalledExactlyOnceWith({
			email: "new@example.com",
			password: "s3cret!",
			dateOfBirth: ADULT_MILLIS,
			captchaToken: undefined,
		});
		await screen.findByLabelText("Phone number");
	});

	it("verifies the phone number and finishes", async () => {
		opened();
		await fillDetails();
		await submit();
		await screen.findByLabelText("Phone number");

		await fireEvent.input(screen.getByLabelText("Phone number"), {
			target: { value: "+15551234567" },
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Send verification code" }),
		);
		await screen.findByLabelText("Verification code");

		await fireEvent.input(screen.getByLabelText("Verification code"), {
			target: { value: "123456" },
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Verify phone number" }),
		);

		expect(verifySmsCode).toHaveBeenCalledExactlyOnceWith({
			profileId: "42",
			code: "123456",
		});
		await screen.findByRole("link", { name: "Sign in" });
	});

	it("explains captcha failures instead of failing silently", async () => {
		createAccount.mockRejectedValueOnce({
			kind: "Recaptcha",
			message: { reason: "addonUnavailable" },
		});
		opened();
		await fillDetails();
		await submit();

		await screen.findByText(/captcha verification/);
		expect(showErrorToast).not.toHaveBeenCalled();
	});

	it("reports other creation failures with a toast", async () => {
		createAccount.mockRejectedValueOnce(new Error("nope"));
		opened();
		await fillDetails();
		await submit();

		await vi.waitFor(() => expect(showErrorToast).toHaveBeenCalledOnce());
		expect(
			screen.getByRole("button", { name: "Create account" }),
		).toBeTruthy();
	});
});
