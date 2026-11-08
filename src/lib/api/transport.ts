import { decode, encode } from "@msgpack/msgpack";
import { invoke } from "@tauri-apps/api/core";
import z from "zod";

import { noticeAccountStatusError } from "$lib/api/account-status-state.svelte";
import { ApiError, type ApiErrorKind } from "$lib/api/api-error";
import {
	awaitBackgroundSwapEnd,
	backgroundSessionSwapInFlight,
	nextRequestSequence,
	requestPredatesSwap,
} from "$lib/api/background-session-swap";
import {
	asAppError,
	blockedKindOf,
	markRequestBlocked,
} from "$lib/api/methods";
import { redactPath } from "$lib/api/redact/text";
import { parseJson } from "$lib/api/redact/value";
import { signOutIfSessionLost } from "$lib/api/session-lost";
import { demoEnabled, demoRoute } from "$lib/demo";
import { deprecatedClientVersionErrorSchema } from "$lib/model/authentication";
import { schemaName } from "$lib/model/schema-names";
import { fromBase64, toBase64 } from "$lib/util/base64";
import { webBackendEnabled } from "$lib/web/bridge";
import type { MediaFileDescriptor } from "$lib/platform/media-file";

type RequestInfo = { method: string; path: string; body?: unknown };

class ExternalRequestError extends ApiError {
	override get retryable(): boolean {
		if (this.kind === "Http" || this.kind === "Connect") return true;
		const status = this.response?.status;
		return status !== undefined && (status >= 500 || status === 408);
	}
}

type ApiErrorClass = typeof ApiError;

function buildRestResponse({
	status,
	responseBody,
	requestInfo,
	ErrorClass = ApiError,
}: {
	status: number;
	responseBody: Uint8Array;
	requestInfo: RequestInfo;
	ErrorClass?: ApiErrorClass;
}) {
	let decoded: string | undefined;
	const text = () => (decoded ??= new TextDecoder().decode(responseBody));
	return {
		status,
		bytes() {
			return responseBody;
		},
		text,
		assertOk() {
			if (status >= 200 && status < 300) {
				return;
			}
			throw new ErrorClass({
				message: `API request failed with status ${status}`,
				request: requestInfo,
				response: { status, body: text() },
			});
		},
		json() {
			try {
				return JSON.parse(text());
			} catch (error) {
				console.error("Failed to parse JSON response", {
					path: requestInfo.path,
					text: text(),
				});
				throw new ErrorClass({
					message: "Failed to parse API response",
					request: requestInfo,
					response: { status, body: text() },
					cause: error,
				});
			}
		},
		jsonParsed<TSchema extends z.ZodType>(schema: TSchema) {
			this.assertOk();
			const data = this.json();
			try {
				return parseApiResponse({
					schema,
					data,
					path: requestInfo.path,
					method: requestInfo.method,
				});
			} catch (error) {
				if (error instanceof ApiError) throw error;
				throw new ErrorClass({
					message: schemaMismatchMessage({
						schema,
						error,
						request: requestInfo,
					}),
					request: requestInfo,
					response: { status, body: text() },
					cause: error,
				});
			}
		},
	};
}

function decodeRestResponse({
	encoded,
	requestInfo,
	ErrorClass,
}: {
	encoded: unknown;
	requestInfo: RequestInfo;
	ErrorClass?: ApiErrorClass;
}) {
	if (typeof encoded !== "string") {
		throw new Error("Invalid response from backend");
	}
	const decoded = decode(fromBase64(encoded));
	const { status, body: responseBody } = z
		.object({ status: z.number(), body: z.instanceof(Uint8Array) })
		.parse(decoded);
	return buildRestResponse({ status, responseBody, requestInfo, ErrorClass });
}

type RestResponse = ReturnType<typeof buildRestResponse>;

async function respondFromDemoOrSend({
	requestInfo,
	ErrorClass,
	send,
}: {
	requestInfo: RequestInfo;
	ErrorClass?: ApiErrorClass;
	send: () => Promise<RestResponse>;
}): Promise<RestResponse> {
	if (!demoEnabled) return await send();
	const { path, method } = requestInfo;
	const { status, body } = demoRoute({
		path,
		method,
		body: requestInfo.body,
	});
	const responseBody = new TextEncoder().encode(JSON.stringify(body ?? null));
	return buildRestResponse({ status, responseBody, requestInfo, ErrorClass });
}

function restInvokeError({
	error,
	requestInfo,
}: {
	error: unknown;
	requestInfo: RequestInfo;
}): ApiError {
	if (error instanceof ApiError) return error;
	const appError = asAppError(error);
	if (appError !== undefined) {
		const blocked = blockedKindOf(appError.kind);
		if (blocked !== undefined) {
			markRequestBlocked({ kind: blocked });
			return new ApiError({
				message:
					blocked === "network"
						? "Request blocked before it reached Grindr"
						: "Request blocked by Grindr",
				request: requestInfo,
				response: null,
				kind: appError.kind,
				cause: error,
			});
		}
	}
	if (appError?.kind === "NotSignedIn" && !backgroundSessionSwapInFlight()) {
		// While a background scan owns the backend session, NotSignedIn is
		// expected (the session belongs to another saved profile for a few
		// seconds) and must never trigger a sign-out.
		signOutIfSessionLost().catch((error) => console.error(error));
	}
	return new ApiError({
		message:
			appError?.prettyMessage ??
			(error instanceof Error ? error.message : String(error)),
		request: requestInfo,
		response: null,
		kind: appError?.kind ?? null,
		cause: error,
	});
}

// A request that started before a background session swap and failed with
// NotSignedIn most likely raced the swap, not a real sign-out: wait for the
// session to settle and try once more before surfacing the error.
const swapSettleWaitMs = 20_000;

// https://github.com/tauri-apps/tauri/issues/10573
export async function invokeRest(
	command: string,
	options: { args: Record<string, unknown>; requestInfo: RequestInfo },
) {
	const { requestInfo } = options;
	const sequence = nextRequestSequence();
	try {
		const encoded = await invoke(command, options.args);
		return decodeRestResponse({ encoded, requestInfo });
	} catch (error) {
		// Only requests that started before the swap can have raced it;
		// requests issued by the scan itself must fail fast instead.
		if (
			asAppError(error)?.kind === "NotSignedIn" &&
			requestPredatesSwap(sequence)
		) {
			await awaitBackgroundSwapEnd(swapSettleWaitMs);
			try {
				const encoded = await invoke(command, options.args);
				return decodeRestResponse({ encoded, requestInfo });
			} catch (retryError) {
				throw restInvokeError({ error: retryError, requestInfo });
			}
		}
		throw restInvokeError({ error, requestInfo });
	}
}

const uploadOutcomeSchema = z.object({
	response: z.string(),
	sha256: z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.nullable(),
	bodySize: z.int().nonnegative(),
});

export async function uploadFileRest(
	path: string,
	options: {
		file: MediaFileDescriptor;
		part: { name: string; filename: string } | null;
		maxBodySize: number;
		profileId: number;
		onHashed?: (sha256: string) => void;
	},
) {
	const method = "POST";
	const requestInfo = { method, path };
	try {
		const outcome = uploadOutcomeSchema.parse(
			await invoke("upload_media_file", {
				file: options.file,
				request: { method, path, part: options.part },
				maxBodySize: options.maxBodySize,
				profileId: String(options.profileId),
			}),
		);
		if (outcome.sha256 !== null) options.onHashed?.(outcome.sha256);
		return {
			response: decodeRestResponse({
				encoded: outcome.response,
				requestInfo,
			}),
			sha256: outcome.sha256,
		};
	} catch (error) {
		throw restInvokeError({ error, requestInfo });
	}
}

export async function uploadWebMediaFile({
	target,
	file,
}: {
	target: "chat" | "profile";
	file: File;
}) {
	const path =
		target === "profile"
			? "/v4/media/upload?takenOnGrindr=false"
			: "/v5/chat/media/upload?takenOnGrindr=false";
	const requestInfo = { method: "POST", path };
	if (!webBackendEnabled) {
		throw new ApiError({
			message: "Media uploads aren't available in this web build",
			request: requestInfo,
		});
	}
	if (file.size > 64 * 1024 * 1024) {
		throw new ApiError({
			message: "Photos over 64 MB can't be uploaded",
			request: requestInfo,
			kind: "ContentTooLarge",
		});
	}
	let normalized: Blob;
	try {
		const bitmap = await createImageBitmap(file);
		try {
			const scale = Math.min(
				1,
				1024 / Math.max(bitmap.width, bitmap.height),
			);
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(bitmap.width * scale));
			canvas.height = Math.max(1, Math.round(bitmap.height * scale));
			const context = canvas.getContext("2d");
			if (!context) throw new Error("Canvas is unavailable");
			context.fillStyle = "white";
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			normalized = await new Promise<Blob>((resolve, reject) => {
				canvas.toBlob(
					(blob) =>
						blob
							? resolve(blob)
							: reject(new Error("Photo encoding failed")),
					"image/jpeg",
					0.85,
				);
			});
		} finally {
			bitmap.close();
		}
	} catch (error) {
		throw new ApiError({
			message: "That photo can't be read in this browser",
			request: requestInfo,
			kind: "Media",
			cause: error,
		});
	}
	try {
		const response = await fetch(`/api/media/upload?target=${target}`, {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "image/jpeg" },
			body: normalized,
		});
		return buildRestResponse({
			status: response.status,
			responseBody: new Uint8Array(await response.arrayBuffer()),
			requestInfo,
			ErrorClass: ExternalRequestError,
		});
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw new ExternalRequestError({
			message: "Couldn't connect to the web upload service",
			request: requestInfo,
			response: null,
			kind: "Connect",
			cause: error,
		});
	}
}

export async function fetchRest(
	path: string,
	options: {
		method?: string;
		body?: unknown;
		abortController?: AbortController;
	} = { method: "GET" },
) {
	const method = options.method ?? "GET";
	const requestInfo = { method, path, body: options.body };
	const response = await respondFromDemoOrSend({
		requestInfo,
		send: () =>
			sendRestRequest({
				requestInfo,
				abortController: options.abortController,
			}),
	});
	noticeRefusedVersion(response);
	return response;
}

function noticeRefusedVersion(response: RestResponse): void {
	if (response.status !== 412) return;
	const body = parseJson(response.text());
	if (!body.ok) return;
	const error = deprecatedClientVersionErrorSchema.safeParse(body.value);
	if (error.success) noticeAccountStatusError(error.data);
}

async function sendRestRequest({
	requestInfo,
	abortController,
}: {
	requestInfo: RequestInfo;
	abortController: AbortController | undefined;
}) {
	const { method, path, body } = requestInfo;
	const payload = encode({
		method,
		path,
		body: body === undefined ? null : encode(body),
	});
	const response = await invokeRest("request", {
		args: { payload: toBase64(payload) },
		requestInfo,
	});
	if (abortController?.signal.aborted) {
		throw new ApiError({
			message: "Request aborted",
			request: requestInfo,
			response: null,
		});
	}
	return response;
}

const externalErrorMessages: Partial<Record<ApiErrorKind, string>> = {
	Connect: "Couldn't connect. Check your internet connection and try again.",
	NetworkBlocked:
		"Something blocked the request before it reached the server",
	RequestBlocked: "The server blocked the request",
	RateLimited: "Too many requests, try again later",
};

function externalInvokeError({
	error,
	requestInfo,
}: {
	error: unknown;
	requestInfo: RequestInfo;
}): ApiError {
	if (error instanceof ApiError) return error;
	const appError = asAppError(error);
	return new ExternalRequestError({
		message:
			(appError && externalErrorMessages[appError.kind]) ??
			appError?.prettyMessage ??
			(error instanceof Error ? error.message : String(error)),
		request: requestInfo,
		response: null,
		kind: appError?.kind ?? null,
		cause: error,
	});
}

function hostQualifiedPath(url: URL): string {
	return `${url.host}${url.pathname}${url.search}`;
}

async function sendExternalRequest({
	url,
	range,
	requestInfo,
}: {
	url: URL;
	range?: string;
	requestInfo: RequestInfo;
}) {
	try {
		const encoded = await invoke("fetch_external", {
			url: url.href,
			range,
		});
		return decodeRestResponse({
			encoded,
			requestInfo,
			ErrorClass: ExternalRequestError,
		});
	} catch (error) {
		throw externalInvokeError({ error, requestInfo });
	}
}

export async function fetchExternal({
	url,
	range,
}: {
	url: URL;
	range?: string;
}) {
	const requestInfo = { method: "GET", path: hostQualifiedPath(url) };
	return await respondFromDemoOrSend({
		requestInfo,
		ErrorClass: ExternalRequestError,
		send: () => sendExternalRequest({ url, range, requestInfo }),
	});
}

export function parseApiResponse<TSchema extends z.ZodType>(options: {
	schema: TSchema;
	data: unknown;
	path: string;
	method?: string;
}): z.infer<TSchema> {
	const parsed = options.schema.safeParse(options.data);
	if (parsed.success) {
		return parsed.data;
	}

	console.error("API response schema validation failed", {
		path: options.path,
		method: options.method ?? "GET",
		schema: schemaName(options.schema),
		issues: parsed.error.issues,
		response: options.data,
	});

	throw parsed.error;
}

function endpointOf(path: string): string {
	const redacted = redactPath(path);
	return redacted.split("?")[0] ?? redacted;
}

export function schemaMismatchMessage({
	schema,
	error,
	request,
}: {
	schema: z.ZodType;
	error: unknown;
	request: RequestInfo;
}): string {
	if (error instanceof z.ZodError) {
		const subject =
			schemaName(schema) ??
			`the schema for ${request.method} ${endpointOf(request.path)}`;
		return `API response did not match ${subject}`;
	}
	return error instanceof Error
		? error.message
		: "API response validation failed";
}
