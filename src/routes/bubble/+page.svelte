<script lang="ts">
	import { listen } from "@tauri-apps/api/event";
	import { getCurrentWindow } from "@tauri-apps/api/window";
	import XIcon from "phosphor-svelte/lib/XIcon";
	import { onMount } from "svelte";

	import { callMethod } from "$lib/api/methods";
	import UserAvatar from "$lib/components/profile/UserAvatar.svelte";
	import { Button } from "$lib/components/ui/button";

	type BubbleData = {
		profileId: string;
		profileName: string;
		conversationId: string | null;
		peerName: string;
		peerAvatarMediaHash: string | null;
		snippet: string;
		unread: number;
	};

	let data = $state<BubbleData | null>(null);

	async function close(): Promise<void> {
		try {
			await callMethod("bubble_close");
		} catch (error) {
			console.error("Could not close the message balloon", error);
			await getCurrentWindow()
				.close()
				.catch(() => {});
		}
	}

	async function openSession(): Promise<void> {
		if (!data) return;
		try {
			await callMethod("bubble_open", {
				profileId: data.profileId,
				profileName: data.profileName,
			});
		} catch (error) {
			console.error("Could not open the session", error);
			await close();
		}
	}

	onMount(() => {
		document.body.style.background = "transparent";
		document.documentElement.style.background = "transparent";
		let disposed = false;
		let unlisten: (() => void) | undefined;
		void (async () => {
			const stop = await listen<BubbleData>(
				"bubble:update",
				(event) => (data = event.payload),
			);
			if (disposed) {
				stop();
				return;
			}
			unlisten = stop;
			const payload = await callMethod("bubble_take");
			if (payload) {
				data = payload;
			} else {
				void close();
			}
		})().catch((error: unknown) => {
			console.error("Could not read the message balloon", error);
			void close();
		});
		return () => {
			disposed = true;
			unlisten?.();
		};
	});
</script>

<svelte:head>
	<title>New message</title>
</svelte:head>

<main class="flex h-dvh items-center justify-center bg-transparent p-3">
	{#if data}
		<section
			aria-label={`New message on ${data.profileName}`}
			class="flex w-full items-center gap-3 rounded-2xl border border-border bg-card p-4 shadow-2xl"
		>
			<div
				role="img"
				aria-label={`${data.peerName}'s profile picture`}
				class="size-16 shrink-0 overflow-hidden rounded-full ring-2 ring-border"
			>
				<UserAvatar
					mediaHash={data.peerAvatarMediaHash}
					size="xl"
					class="size-full"
				/>
			</div>
			<div class="min-w-0 flex-1">
				<header class="flex items-center gap-2">
					<p class="truncate text-sm font-semibold">
						{data.peerName}
					</p>
					<span
						class="ms-auto shrink-0 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground"
					>
						{data.unread > 9 ? "9+" : data.unread}
					</span>
				</header>
				<p class="mt-1 line-clamp-2 text-sm text-muted-foreground">
					{data.snippet}
				</p>
				<p class="mt-1 truncate text-xs text-muted-foreground">
					on {data.profileName} · click Open to switch sessions
				</p>
				<footer class="mt-3 flex justify-end gap-2">
					<Button
						size="sm"
						variant="ghost"
						onclick={() => void close()}
					>
						<XIcon class="size-4" />
						Dismiss
					</Button>
					<Button size="sm" onclick={() => void openSession()}>
						Open
					</Button>
				</footer>
			</div>
		</section>
	{/if}
</main>
