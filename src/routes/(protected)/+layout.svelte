<script lang="ts">
	import { onMount } from "svelte";

	import { scanUnreadAutomaticRepliesAtStartup } from "$lib/chat/automatic-replies";
	import {
		refreshOtherSessionsUnread,
		startOtherSessionsUnreadPolling,
	} from "$lib/chat/other-sessions-unread.svelte";
	import {
		refreshSecondaryStatus,
		startSecondarySessionsListener,
	} from "$lib/chat/secondary-sessions.svelte";
	import CommandCenter from "$lib/components/command-center/CommandCenter.svelte";
	import MediaDropOverlay from "$lib/components/shared/MediaDropOverlay.svelte";
	import { restoreStrandedLocation } from "$lib/entitlements/honduras-hold";
	import { listenForKeyboardMedia } from "$lib/platform/keyboard-media.svelte";
	import { listenForMedia } from "$lib/platform/media-intake.svelte";
	import { startOnlineHeartbeat } from "$lib/presence/online-heartbeat";
	import { guardDeletedPages } from "$lib/util/deleted-pages";
	import { retryBrokenMediaWhenOnline } from "$lib/util/media-retry-signals";

	let { data, children }: import("./$types").LayoutProps = $props();
	let startupReady = $state(false);

	guardDeletedPages();

	$effect(() => {
		if (!startupReady) return;
		return startOnlineHeartbeat();
	});
	$effect(() => {
		if (!startupReady) return;
		return retryBrokenMediaWhenOnline();
	});
	$effect(() => {
		if (!startupReady) return;
		return listenForMedia();
	});
	$effect(() => {
		if (!startupReady) return;
		return listenForKeyboardMedia();
	});
	$effect(() => {
		if (!startupReady) return;
		void refreshOtherSessionsUnread().catch(() => {});
		return startOtherSessionsUnreadPolling();
	});
	$effect(() => {
		if (!startupReady) return;
		void refreshSecondaryStatus().catch(() => {});
	});

	onMount(() => {
		// Attach before the startup unread scan so live background messages
		// cannot arrive in the gap while the UI waits for that scan.
		const stopSecondarySessionsListener = startSecondarySessionsListener();
		void scanUnreadAutomaticRepliesAtStartup(data.ourProfileId)
			.catch(() => {})
			.finally(() => {
				startupReady = true;
				restoreStrandedLocation().catch((error: unknown) => {
					console.error("Could not move back from Honduras", error);
				});
			});
		return stopSecondarySessionsListener;
	});
</script>

{#if startupReady}
	{@render children()}
	<CommandCenter />
	<MediaDropOverlay />
{:else}
	<main
		class="grid min-h-dvh place-items-center px-6 text-center text-muted-foreground"
		role="status"
		aria-live="polite"
	>
		Checking saved profiles for unread messages…
	</main>
{/if}
