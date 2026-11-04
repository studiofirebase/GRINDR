import type { ClientInit, HandleClientError } from "@sveltejs/kit";

import { installWebBridge } from "$lib/web/bridge";

// The web backend shim must be installed before $lib/ws.svelte is first
// imported: building its WsState subscribes via Tauri `listen`, which needs
// window.__TAURI_INTERNALS__. On desktop the native WebView injects those
// before any JS runs, but on web only installWebBridge provides them, and
// SvelteKit evaluates static imports before init() runs — so both the
// install and the ws import happen dynamically here, after init starts.
export const init: ClientInit = async () => {
	await installWebBridge();
	const { ws } = await import("$lib/ws.svelte");
	ws.connect();
};

export const handleError: HandleClientError = ({ error, event }) => {
	console.error("Error during request to", event.url.pathname, ":", error);
};
