// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type Bridge = typeof import("$lib/web/bridge");

let invoke: (
	command: string,
	args?: Record<string, unknown>,
) => Promise<unknown>;
const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
	};
}

beforeAll(async () => {
	vi.stubEnv("OPEN_GRIND_WEB", "1");
	vi.stubGlobal(
		"fetch",
		fetchMock.mockImplementation((url: string) => {
			if (url === "/api/profiles")
				return Promise.resolve(jsonResponse(200, []));
			if (url === "/api/auth/create-account") {
				return Promise.resolve(
					jsonResponse(200, {
						profileId: "42",
						verificationRequired: true,
					}),
				);
			}
			if (url === "/api/auth/sms/send-code")
				return Promise.resolve(jsonResponse(200, {}));
			if (url === "/api/auth/sms/verify-code")
				return Promise.resolve(jsonResponse(200, {}));
			throw new Error(`unexpected fetch: ${url}`);
		}),
	);
	const bridge: Bridge = await import("$lib/web/bridge");
	await bridge.installWebBridge();
	invoke = (
		window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }
	).__TAURI_INTERNALS__.invoke;
});

afterEach(() => {
	fetchMock.mockClear();
});

describe("web bridge account creation", () => {
	it("routes create_account to the web backend", async () => {
		await expect(
			invoke("create_account", {
				email: "new@example.com",
				password: "s3cret!",
				dateOfBirth: 946_684_800_000,
				captchaToken: undefined,
			}),
		).resolves.toEqual({ profileId: "42", verificationRequired: true });

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/auth/create-account",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("routes the SMS verification commands to the web backend", async () => {
		await invoke("sms_send_code", {
			profileId: "42",
			phoneNumber: "+15551234567",
		});
		await invoke("sms_verify_code", { profileId: "42", code: "123456" });

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/auth/sms/send-code",
			expect.objectContaining({ method: "POST" }),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/auth/sms/verify-code",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("keeps rejecting unknown commands", async () => {
		await expect(invoke("frobnicate", {})).rejects.toThrow(
			'"frobnicate" is not available in the web build',
		);
	});
});
