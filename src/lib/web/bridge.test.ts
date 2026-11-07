import { afterEach, describe, expect, it, vi } from "vitest";

import { adminMe } from "$lib/web/bridge";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

afterEach(() => {
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("admin login overlay", () => {
	it("goes straight to the app after Entrar without offering admin creation", async () => {
		const requested: string[] = [];
		let meCalls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string): Promise<Response> => {
				const path = input;
				requested.push(path);
				if (path === "/api/me") {
					meCalls += 1;
					if (meCalls === 1)
						return Promise.resolve(jsonResponse({}, 401));
					return Promise.resolve(
						jsonResponse({
							username: "italosantos",
							isSuper: true,
						}),
					);
				}
				if (path === "/api/login")
					return Promise.resolve(jsonResponse({ ok: true }));
				if (path === "/api/admins") {
					return Promise.resolve(
						jsonResponse([
							{ username: "italosantos", isSuper: true },
						]),
					);
				}
				return Promise.resolve(jsonResponse({}, 404));
			}),
		);

		const pending = adminMe();
		await vi.waitFor(() => {
			expect(document.querySelector("[data-login-form]")).not.toBeNull();
		});
		const form = document.querySelector(
			"[data-login-form]",
		) as HTMLFormElement;
		(form.elements.namedItem("username") as HTMLInputElement).value =
			"italosantos";
		(form.elements.namedItem("password") as HTMLInputElement).value =
			"secret123";
		form.dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true }),
		);

		await expect(pending).resolves.toEqual({
			username: "italosantos",
			isSuper: true,
		});
		expect(
			requested.filter((path) => path.includes("/api/admins")),
		).toEqual([]);
		expect(document.body.textContent ?? "").not.toContain(
			"Criar novo admin",
		);
		expect(document.querySelector("[data-login-form]")).toBeNull();
	});

	it("rethrows structured Grindr errors instead of flattening them", async () => {
		// Simulates what /api/auth/email now returns for a Grindr
		// rejection: the rejection must keep its kind/code shape so the
		// sign-in form can tell bad credentials apart from other errors.
		const structured = {
			kind: "Api",
			message: { code: 4, message: "Invalid input parameters" },
		};
		vi.stubGlobal(
			"fetch",
			vi.fn((): Promise<Response> => {
				return Promise.resolve(
					jsonResponse({ error: structured }, 422),
				);
			}),
		);

		await expect(adminMe()).rejects.toEqual(structured);
	});
});
