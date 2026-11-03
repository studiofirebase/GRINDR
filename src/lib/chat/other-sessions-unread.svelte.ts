import { isTauri } from "@tauri-apps/api/core";
import { toast } from "svelte-sonner";
import { SvelteMap, SvelteSet } from "svelte/reactivity";

import { beginBackgroundSessionSwap } from "$lib/api/background-session-swap";
import { getConversations } from "$lib/api/messaging/conversations";
import { callMethod } from "$lib/api/methods";
import { scanUnreadAutomaticRepliesForProfile } from "$lib/chat/automatic-replies";
import { demoEnabled } from "$lib/demo";
import { isDesktopPlatform } from "$lib/platform/os";
import { notify } from "$lib/push";
import { webBackendEnabled } from "$lib/web/bridge";

// How many inbox pages to walk per saved profile while the pages still carry
// unread conversations. Unreads concentrate on recent pages, so a small cap
// keeps background scans cheap.
const maxScanPages = 5;

// Default delay between background scans of the inactive saved profiles.
export const otherSessionsPollIntervalMs = 5 * 60_000;

function backendAvailable(): boolean {
	return (isTauri() || webBackendEnabled) && !demoEnabled;
}

function isHiddenDocument(): boolean {
	return (
		typeof document !== "undefined" && document.visibilityState === "hidden"
	);
}

function unreadOf(entry: unknown): number {
	const count = (entry as { data?: { unreadCount?: unknown } } | null)?.data
		?.unreadCount;
	return typeof count === "number" && count > 0 ? Math.floor(count) : 0;
}

class OtherSessionsUnreadState {
	counts = $state<Record<string, number>>({});
	checking = $state(false);
	lastCheckedAt = $state<number | null>(null);

	get total(): number {
		return Object.values(this.counts).reduce(
			(sum, count) => sum + count,
			0,
		);
	}

	unreadFor(profileId: string): number {
		return this.counts[profileId] ?? 0;
	}

	/** Test-only reset; the state is a process-wide singleton otherwise. */
	resetForTesting(): void {
		this.counts = {};
		this.checking = false;
		this.lastCheckedAt = null;
		for (const key of Object.keys(lastAiScanTotal))
			delete lastAiScanTotal[key];
		for (const key of Object.keys(peerDetails)) delete peerDetails[key];
		for (const key of Object.keys(profileNames)) delete profileNames[key];
		pendingBackgroundSync.clear();
		liveBackgroundState.lastBalloonAt = null;
	}
}

export const otherSessionsUnread = new OtherSessionsUnreadState();

let inFlight: Promise<void> | null = null;
const notified: Record<string, number> = {};
// Totals the automatic replies already answered, per profile. The periodic
// scanner and the live background sync both consult this so neither
// re-answers the same unread twice.
const lastAiScanTotal: Record<string, number> = {};
type PeerDetails = {
	conversationId: string | null;
	peerName: string;
	peerAvatarMediaHash: string | null;
	snippet: string;
};

// Latest known unread conversation per profile, backing live balloons when
// the websocket event does not contain the peer's profile photo.
const peerDetails: Record<string, PeerDetails> = {};
const profileNames: Record<string, string> = {};
// Serialized single-profile background syncs (live message arrivals).
const pendingBackgroundSync = new SvelteSet<string>();
let backgroundSyncQueue: Promise<void> = Promise.resolve();

/** When the last live background balloon fired, if ever. */
export const liveBackgroundState: { lastBalloonAt: number | null } = {
	lastBalloonAt: null,
};

type InboxScan = {
	total: number;
	conversationId: string | null;
	peerName: string;
	peerAvatarMediaHash: string | null;
	snippet: string;
} | null;

function detailsFromScan(scan: Exclude<InboxScan, null>): PeerDetails {
	return {
		conversationId: scan.conversationId,
		peerName: scan.peerName,
		peerAvatarMediaHash: scan.peerAvatarMediaHash,
		snippet: scan.snippet,
	};
}

function snippetOf(
	preview: { type?: unknown; text?: unknown } | null | undefined,
): string {
	if (
		preview?.type === "Text" &&
		typeof preview.text === "string" &&
		preview.text.trim() !== ""
	)
		return preview.text;
	return "Sent you a message";
}

async function scanInbox(preferredConversationId?: string): Promise<InboxScan> {
	let total = 0;
	let first: PeerDetails | null = null;
	let page: number | null = 1;
	let pages = 0;
	while (page !== null && pages < maxScanPages) {
		pages += 1;
		let inbox: Awaited<ReturnType<typeof getConversations>>;
		try {
			inbox = await getConversations({ page });
		} catch (error) {
			console.error("Could not read inbox of another session", error);
			return null;
		}
		let pageUnread = 0;
		for (const entry of inbox.entries) {
			const data = (
				entry as {
					data?: {
						conversationId?: unknown;
						name?: unknown;
						participants?: { primaryMediaHash?: unknown }[];
						preview?: { type?: unknown; text?: unknown } | null;
						unreadCount?: unknown;
					};
				} | null
			)?.data;
			const avatarHash = data?.participants?.[0]?.primaryMediaHash;
			const count = unreadOf(entry);
			pageUnread += count;
			total += count;
			const isPreferred =
				preferredConversationId !== undefined &&
				data?.conversationId === preferredConversationId;
			if ((count > 0 || isPreferred) && (first === null || isPreferred)) {
				first = {
					conversationId:
						typeof data?.conversationId === "string"
							? data.conversationId
							: null,
					peerName:
						typeof data?.name === "string" && data.name !== ""
							? data.name
							: "Someone",
					peerAvatarMediaHash:
						typeof avatarHash === "string" ? avatarHash : null,
					snippet: snippetOf(data?.preview),
				};
			}
		}
		page = pageUnread > 0 ? inbox.nextPage : null;
	}
	return {
		total,
		...(first ?? {
			conversationId: null,
			peerName: "Someone",
			peerAvatarMediaHash: null,
			snippet: "Sent you a message",
		}),
	};
}

async function notifyNewMessages({
	profileId,
	profileName,
	unread,
	conversationId,
	peerName,
	peerAvatarMediaHash,
	snippet,
}: {
	profileId: string;
	profileName: string;
	unread: number;
	conversationId: string | null;
	peerName: string;
	peerAvatarMediaHash: string | null;
	snippet: string;
}): Promise<void> {
	const body = `${unread} new message${unread === 1 ? "" : "s"} on ${profileName}`;
	if (!isDesktopPlatform()) {
		toast.info(body, { description: "Open Profiles to switch sessions." });
		return;
	}
	// Floating balloon over every app and site. Falls back to a system
	// notification, then to an in-app toast, if the window cannot open.
	try {
		await callMethod("bubble_show", {
			profileId,
			profileName,
			conversationId,
			peerName,
			peerAvatarMediaHash,
			snippet,
			unread,
		});
		return;
	} catch (error) {
		console.error("Could not show the message balloon", error);
	}
	try {
		await notify({
			category: "messages",
			tag: `other-session:${profileId}`,
			messageId: null,
			title: profileName,
			body,
			deeplink: "grindr://profiles",
		});
	} catch (error) {
		console.error("Could not show the system notification", error);
		toast.info(body, { description: "Open Profiles to switch sessions." });
	}
}

/**
 * Reunites the backend session with the visible one after a background
 * check. Never yanks the user back if they switched sessions mid-check:
 * then the backend follows the user's choice instead of `starting`, so the
 * two can never stay pointed at different profiles.
 */
async function restoreSessionIfUntouched(
	starting: string,
	currentId: string,
): Promise<void> {
	if (currentId === starting) return;
	const active = await callMethod("current_session").catch(() => null);
	const activeId =
		typeof active?.profileId === "number" ? String(active.profileId) : null;
	if (activeId === null) return;
	if (activeId !== currentId && activeId !== starting) {
		// The user moved mid-scan: bring the backend to their session.
		await callMethod("profile_switch", { profileId: activeId }).catch(
			(error: unknown) => {
				console.error("Could not follow the active session", error);
			},
		);
		return;
	}
	if (activeId === currentId) {
		await callMethod("profile_switch", { profileId: starting }).catch(
			(error: unknown) => {
				console.error("Could not restore the active session", error);
			},
		);
	}
}

/**
 * Counts unread conversations on every saved profile except the active one
 * by briefly switching the backend session over and back. Skips while a
 * scan is already running or the page is hidden. Failures keep the previous
 * counts; only increases over the last notified totals toast.
 */
export function refreshOtherSessionsUnread({
	notify = true,
}: { notify?: boolean } = {}): Promise<void> {
	if (!backendAvailable() || isHiddenDocument()) return Promise.resolve();
	inFlight ??= runRefresh({ notify }).finally(() => {
		inFlight = null;
	});
	return inFlight;
}

async function runRefresh({ notify }: { notify: boolean }): Promise<void> {
	otherSessionsUnread.checking = true;
	try {
		let session: Awaited<ReturnType<typeof callMethod<"current_session">>>;
		try {
			session = await callMethod("current_session");
		} catch {
			return;
		}
		const startingId =
			typeof session?.profileId === "number" ? session.profileId : null;
		if (startingId === null) return;
		const starting = String(startingId);

		let saved: Awaited<ReturnType<typeof callMethod<"profile_list">>>;
		try {
			saved = await callMethod("profile_list");
		} catch {
			return;
		}
		const names = new Map(saved.map((p) => [p.profileId, p.name]));
		for (const [profileId, name] of names) profileNames[profileId] = name;
		const targets = saved.filter((p) => p.profileId !== starting);
		if (targets.length === 0) {
			otherSessionsUnread.counts = {};
			return;
		}

		let currentId = starting;
		const scanned = new SvelteMap<string, Exclude<InboxScan, null>>();
		// Hold the swap guard across every backend session switch (there
		// and back) so concurrent requests that fail with NotSignedIn are
		// treated as transient instead of triggering a sign-out.
		const endSwap = beginBackgroundSessionSwap();
		try {
			for (const target of targets) {
				try {
					// Quiet borrow: no websocket, no stored-active flap, no
					// media/secondary churn. Restored afterwards.
					await callMethod("profile_scan_switch", {
						profileId: target.profileId,
					});
					currentId = target.profileId;
				} catch (error) {
					console.error(
						`Could not check session ${target.profileId}`,
						error,
					);
					continue;
				}
				const scan = await scanInbox();
				if (scan !== null) scanned.set(target.profileId, scan);
				// Let the AI answer this session too when new unread showed
				// up. lastAiScanTotal tracks what it already answered, so
				// the live background sync and this scanner never re-answer
				// the same unread twice.
				const lastAi = lastAiScanTotal[target.profileId];
				if (
					scan !== null &&
					scan.total > 0 &&
					(lastAi === undefined || scan.total > lastAi)
				) {
					const numericId = Number(target.profileId);
					if (Number.isSafeInteger(numericId) && numericId > 0) {
						try {
							await scanUnreadAutomaticRepliesForProfile(
								numericId,
							);
						} finally {
							lastAiScanTotal[target.profileId] = scan.total;
						}
					}
				}
			}
		} finally {
			try {
				await restoreSessionIfUntouched(starting, currentId);
			} finally {
				endSwap();
			}
		}

		// Keep the previous count for profiles whose scan failed; drop
		// profiles that are no longer saved.
		const previous = otherSessionsUnread.counts;
		const next: Record<string, number> = {};
		const details = new SvelteMap<string, PeerDetails>();
		for (const target of targets) {
			const scan = scanned.get(target.profileId);
			if (scan !== undefined) {
				next[target.profileId] = scan.total;
				const detail = detailsFromScan(scan);
				details.set(target.profileId, detail);
				peerDetails[target.profileId] = detail;
				continue;
			}
			const kept = previous[target.profileId];
			if (kept !== undefined) next[target.profileId] = kept;
		}
		otherSessionsUnread.counts = next;
		otherSessionsUnread.lastCheckedAt = Date.now();

		if (notify) {
			const jobs: Promise<void>[] = [];
			for (const [profileId, total] of Object.entries(next)) {
				const previous = notified[profileId];
				if (total > 0 && previous !== undefined && total > previous) {
					const detail = details.get(profileId) ?? {
						conversationId: null,
						peerName: "Someone",
						peerAvatarMediaHash: null,
						snippet: "Sent you a message",
					};
					jobs.push(
						notifyNewMessages({
							profileId,
							profileName:
								names.get(profileId) ?? `profile ${profileId}`,
							unread: total,
							conversationId: detail.conversationId,
							peerName: detail.peerName,
							peerAvatarMediaHash: detail.peerAvatarMediaHash,
							snippet: detail.snippet,
						}),
					);
				}
				if (total > 0 || previous !== undefined)
					notified[profileId] = total;
			}
			await Promise.all(jobs);
			for (const profileId of Object.keys(notified)) {
				if (!(profileId in next)) delete notified[profileId];
			}
		}
	} finally {
		otherSessionsUnread.checking = false;
	}
}

/**
 * Starts the background poller. Refreshes on an interval and whenever the
 * page becomes visible again. Returns a stop function for cleanup.
 */
export function startOtherSessionsUnreadPolling(
	intervalMs: number = otherSessionsPollIntervalMs,
): () => void {
	if (!backendAvailable() || typeof window === "undefined") return () => {};
	const timer = window.setInterval(() => {
		void refreshOtherSessionsUnread().catch(() => {});
	}, intervalMs);
	const onVisible = () => {
		if (document.visibilityState === "visible") {
			void refreshOtherSessionsUnread({ notify: false }).catch(() => {});
		}
	};
	document.addEventListener("visibilitychange", onVisible);
	return () => {
		window.clearInterval(timer);
		document.removeEventListener("visibilitychange", onVisible);
	};
}

export type LiveBackgroundMessage = {
	profileId: string;
	profileName?: string;
	conversationId?: string;
	peerName?: string;
	peerAvatarMediaHash?: string | null;
	snippet?: string;
};

/**
 * Records a live incoming message seen on a background session's own
 * websocket: bumps the badge immediately, fires the floating balloon, and
 * queues a single-profile sync so the AI replies without a full scan.
 */
export function noteLiveBackgroundMessage(
	message: LiveBackgroundMessage,
): void {
	const { profileId } = message;
	if (!backendAvailable() || profileId === "") return;
	const total = (otherSessionsUnread.counts[profileId] ?? 0) + 1;
	otherSessionsUnread.counts = {
		...otherSessionsUnread.counts,
		[profileId]: total,
	};
	// The balloon below covers this total; the periodic scanner only toasts
	// about later increases.
	notified[profileId] = total;
	const detail = peerDetails[profileId];
	const matchesDetail =
		message.conversationId === undefined ||
		message.conversationId === detail?.conversationId;
	const profileName =
		message.profileName ??
		profileNames[profileId] ??
		`profile ${profileId}`;
	const conversationId =
		message.conversationId ?? detail?.conversationId ?? null;
	void notifyNewMessages({
		profileId,
		profileName,
		unread: total,
		conversationId,
		peerName:
			message.peerName ??
			(matchesDetail ? detail?.peerName : undefined) ??
			"Someone",
		peerAvatarMediaHash:
			message.peerAvatarMediaHash ??
			(matchesDetail ? detail?.peerAvatarMediaHash : undefined) ??
			null,
		snippet:
			message.snippet ??
			(matchesDetail ? detail?.snippet : undefined) ??
			"Sent you a message",
	}).catch(() => {});
	liveBackgroundState.lastBalloonAt = Date.now();
	queueBackgroundProfileSync(profileId, profileName, conversationId);
}

function queueBackgroundProfileSync(
	profileId: string,
	profileName: string,
	conversationId: string | null,
): void {
	if (pendingBackgroundSync.has(profileId)) return;
	pendingBackgroundSync.add(profileId);
	backgroundSyncQueue = backgroundSyncQueue
		.catch(() => {})
		.then(() =>
			syncBackgroundProfile(profileId, profileName, conversationId),
		)
		.catch((error: unknown) => {
			console.error(
				`Could not sync background session ${profileId}`,
				error,
			);
		})
		.finally(() => {
			pendingBackgroundSync.delete(profileId);
		});
}

/**
 * Syncs one background profile flagged by its live socket: switches the
 * backend over, rescans its inbox for authoritative counts, lets the AI
 * answer new unread, then restores the visible session.
 */
async function syncBackgroundProfile(
	profileId: string,
	profileName: string,
	conversationId: string | null,
): Promise<void> {
	const numericId = Number(profileId);
	if (!Number.isSafeInteger(numericId) || numericId <= 0) return;
	let starting: string | null = null;
	let currentId: string | null = null;
	const endSwap = beginBackgroundSessionSwap();
	try {
		let session: Awaited<ReturnType<typeof callMethod<"current_session">>>;
		try {
			session = await callMethod("current_session");
		} catch {
			return;
		}
		starting =
			typeof session?.profileId === "number"
				? String(session.profileId)
				: null;
		if (starting === null) return;
		currentId = starting;
		if (starting !== profileId) {
			try {
				await callMethod("profile_scan_switch", { profileId });
			} catch (error) {
				console.error(`Could not check session ${profileId}`, error);
				return;
			}
			currentId = profileId;
		}
		const scan = await scanInbox(conversationId ?? undefined);
		if (scan === null) return;
		otherSessionsUnread.counts = {
			...otherSessionsUnread.counts,
			[profileId]: scan.total,
		};
		// The live balloon already covered this total; later scans only
		// toast about increases past it.
		notified[profileId] = scan.total;
		peerDetails[profileId] = detailsFromScan(scan);
		otherSessionsUnread.lastCheckedAt = Date.now();
		void callMethod("bubble_update", {
			profileId,
			profileName,
			conversationId: scan.conversationId ?? conversationId,
			peerName: scan.peerName,
			peerAvatarMediaHash: scan.peerAvatarMediaHash,
			snippet: scan.snippet,
			unread: Math.max(scan.total, 1),
		}).catch((error: unknown) => {
			console.error("Could not update the message balloon", error);
		});
		const lastAi = lastAiScanTotal[profileId];
		if (scan.total > 0 && (lastAi === undefined || scan.total > lastAi)) {
			try {
				await scanUnreadAutomaticRepliesForProfile(numericId);
			} finally {
				lastAiScanTotal[profileId] = scan.total;
			}
		}
	} finally {
		try {
			if (starting !== null && currentId !== null) {
				await restoreSessionIfUntouched(starting, currentId);
			}
		} finally {
			endSwap();
		}
	}
}
