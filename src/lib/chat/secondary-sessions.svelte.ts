import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { callMethod } from "$lib/api/methods";
import { noteLiveBackgroundMessage } from "$lib/chat/other-sessions-unread.svelte";
import { demoEnabled } from "$lib/demo";
import { chatV1MessageSentEventSchema } from "$lib/ws.svelte";

export type SecondarySessionStatus = { profileId: string; wsOnline: boolean };

class SecondarySessionsState {
	entries = $state<SecondarySessionStatus[]>([]);

	get onlineCount(): number {
		return this.entries.filter((entry) => entry.wsOnline).length;
	}

	isOnline(profileId: string): boolean {
		return this.entries.some(
			(entry) => entry.profileId === profileId && entry.wsOnline,
		);
	}

	/** Test-only reset; the state is a process-wide singleton otherwise. */
	resetForTesting(): void {
		this.entries = [];
	}
}

export const secondarySessions = new SecondarySessionsState();

let statusInFlight: Promise<void> | null = null;

function backendAvailable(): boolean {
	return isTauri() && !demoEnabled;
}

/**
 * Reloads which saved profiles hold a live background websocket. Only the
 * desktop backend runs secondary clients; elsewhere the list stays empty.
 */
export function refreshSecondaryStatus(): Promise<void> {
	if (!backendAvailable()) return Promise.resolve();
	statusInFlight ??= callMethod("secondary_status")
		.then((entries) => {
			secondarySessions.entries = entries;
		})
		.catch((error: unknown) => {
			console.error("Could not load background session status", error);
		})
		.finally(() => {
			statusInFlight = null;
		});
	return statusInFlight;
}

type BackgroundChatEvent = {
	profile_id: unknown;
	profile_name: unknown;
	event: unknown;
};

function snippetFor(message: Record<string, unknown>): string {
	const text = (message["body"] as Record<string, unknown> | undefined)?.[
		"text"
	];
	if (message["type"] === "Text" && typeof text === "string") {
		const trimmed = text.trim();
		if (trimmed !== "") {
			return trimmed.length > 140 ? `${trimmed.slice(0, 140)}…` : trimmed;
		}
	}
	switch (message["type"]) {
		case "Image":
		case "ExpiringImage":
			return "Sent you a photo";
		case "Audio":
			return "Sent you a voice message";
		case "Video":
			return "Sent you a video";
		case "Giphy":
		case "Gaymoji":
			return "Sent you a GIF";
		case "Location":
			return "Shared a location with you";
		default:
			return "Sent you a message";
	}
}

/**
 * Listens for chat messages arriving on background sessions' own
 * websockets. Each incoming message bumps that profile's badge, fires the
 * floating balloon, and lets the AI answer — no session switch needed to
 * notice. Ignores our own echoes and unparseable payloads; the periodic
 * scanner reconciles anything missed.
 */
export function startSecondarySessionsListener(): () => void {
	if (!backendAvailable() || typeof window === "undefined") return () => {};
	let settled = false;
	let unlisten: (() => void) | undefined;
	listen<BackgroundChatEvent>(
		"grindr:background:chat_v1_message_sent",
		(tauriEvent) => {
			const rawId = tauriEvent.payload?.profile_id;
			if (typeof rawId !== "string" || rawId === "") return;
			const parsed = chatV1MessageSentEventSchema.safeParse(
				tauriEvent.payload?.event,
			);
			if (!parsed.success) return;
			const message = parsed.data.payload as unknown as Record<
				string,
				unknown
			>;
			if (message["senderId"] === Number(rawId)) return;
			const rawName = tauriEvent.payload?.profile_name;
			const conversationId = message["conversationId"];
			void refreshSecondaryStatus().catch(() => {});
			noteLiveBackgroundMessage({
				profileId: rawId,
				profileName:
					typeof rawName === "string" && rawName !== ""
						? rawName
						: undefined,
				conversationId:
					typeof conversationId === "string"
						? conversationId
						: undefined,
				snippet: snippetFor(message),
			});
		},
	)
		.then((fn) => {
			if (settled) fn();
			else unlisten = fn;
		})
		.catch((error: unknown) => {
			console.error(
				"Could not listen for background session messages",
				error,
			);
		});
	return () => {
		settled = true;
		unlisten?.();
	};
}
