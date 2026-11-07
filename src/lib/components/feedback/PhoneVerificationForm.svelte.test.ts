// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
	sendSmsVerificationCode,
	verifySmsCode,
	showErrorToast,
	toast,
	onVerified,
} = vi.hoisted(() => ({
	sendSmsVerificationCode: vi.fn(),
	verifySmsCode: vi.fn(),
	showErrorToast: vi.fn(),
	toast: { success: vi.fn() },
	onVerified: vi.fn(),
}));

vi.mock("$lib/api/registration/sms", () => ({
	sendSmsVerificationCode,
	verifySmsCode,
}));
vi.mock("$lib/api/error-toast", () => ({ showErrorToast }));
vi.mock("svelte-sonner", () => ({ toast }));

import PhoneVerificationForm from "./PhoneVerificationForm.svelte";

const label = (name: string) => screen.getByLabelText(name);
const button = (name: string) => screen.getByRole("button", { name });

function fillPhone() {
	return fireEvent.input(label("Phone number"), {
		target: { value: "+15551234567" },
	});
}

function fillCode() {
	return fireEvent.input(label("Verification code"), {
		target: { value: "123456" },
	});
}

async function sendCode() {
	render(PhoneVerificationForm, { props: { profileId: "42", onVerified } });
	await fillPhone();
	await fireEvent.click(button("Send verification code"));
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("PhoneVerificationForm", () => {
	it("sends the code for the unverified profile", async () => {
		await sendCode();

		expect(sendSmsVerificationCode).toHaveBeenCalledExactlyOnceWith({
			profileId: "42",
			phoneNumber: "+15551234567",
		});
		expect(toast.success).toHaveBeenCalledOnce();
		await screen.findByLabelText("Verification code");
	});

	it("verifies the code and reports back", async () => {
		await sendCode();
		await fillCode();
		await fireEvent.click(button("Verify phone number"));

		expect(verifySmsCode).toHaveBeenCalledExactlyOnceWith({
			profileId: "42",
			code: "123456",
		});
		expect(toast.success).toHaveBeenCalledTimes(2);
		expect(onVerified).toHaveBeenCalledOnce();
	});

	it("shows a toast when sending fails", async () => {
		sendSmsVerificationCode.mockRejectedValueOnce(new Error("nope"));
		render(PhoneVerificationForm, {
			props: { profileId: "42", onVerified },
		});
		await fillPhone();
		await fireEvent.click(button("Send verification code"));

		await vi.waitFor(() => expect(showErrorToast).toHaveBeenCalledOnce());
		expect(screen.queryByLabelText("Verification code")).toBeNull();
	});

	it("shows a toast when verifying fails", async () => {
		verifySmsCode.mockRejectedValueOnce(new Error("nope"));
		await sendCode();
		await fillCode();
		await fireEvent.click(button("Verify phone number"));

		await vi.waitFor(() => expect(showErrorToast).toHaveBeenCalledOnce());
		expect(onVerified).not.toHaveBeenCalled();
	});
});
