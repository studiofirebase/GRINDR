import { beforeEach, describe, expect, it, vi } from "vitest";

const { callMethod } = vi.hoisted(() => ({ callMethod: vi.fn() }));

vi.mock("$lib/api/methods", () => ({ callMethod }));

import {
	sendSmsVerificationCode,
	verifySmsCode,
} from "$lib/api/registration/sms";

beforeEach(() => {
	vi.clearAllMocks();
	callMethod.mockResolvedValue({});
});

describe("phone verification", () => {
	it("requests the code for the unverified profile", async () => {
		await sendSmsVerificationCode({
			profileId: "42",
			phoneNumber: "+15551234567",
		});

		expect(callMethod).toHaveBeenCalledExactlyOnceWith("sms_send_code", {
			profileId: "42",
			phoneNumber: "+15551234567",
		});
	});

	it("confirms the code for the unverified profile", async () => {
		await verifySmsCode({ profileId: "42", code: "123456" });

		expect(callMethod).toHaveBeenCalledExactlyOnceWith("sms_verify_code", {
			profileId: "42",
			code: "123456",
		});
	});
});
