<script lang="ts">
	import { listen } from "@tauri-apps/api/event";
	import { goto } from "$app/navigation";
	import ArrowsLeftRightIcon from "phosphor-svelte/lib/ArrowsLeftRightIcon";
	import CheckIcon from "phosphor-svelte/lib/CheckIcon";
	import PlusIcon from "phosphor-svelte/lib/PlusIcon";
	import ShieldCheckIcon from "phosphor-svelte/lib/ShieldCheckIcon";
	import SignOutIcon from "phosphor-svelte/lib/SignOutIcon";
	import { onMount } from "svelte";
	import { toast } from "svelte-sonner";

	import { clearAccountCaches } from "$lib/api/account-caches";
	import { callMethod } from "$lib/api/methods";
	import {
		clearAccountPreferences,
		setPreferences,
	} from "$lib/app-data/preferences.svelte";
	import {
		otherSessionsUnread,
		refreshOtherSessionsUnread,
	} from "$lib/chat/other-sessions-unread.svelte";
	import {
		refreshSecondaryStatus,
		secondarySessions,
	} from "$lib/chat/secondary-sessions.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
	import { demoEnabled } from "$lib/demo";
	import {
		type AdminInfo,
		adminLogout,
		adminMe,
		openCreateAdminDialog,
		webBackendEnabled,
	} from "$lib/web/bridge";

	type Profile = { profileId: string; name: string; active: boolean };

	const maxProfiles = 5;
	let profiles = $state<Profile[]>([]);
	let busy = $state(false);
	let admin = $state<AdminInfo | undefined>();
	let open = $state(false);
	let currentProfileId = $state<number | null>(null);

	const showDisconnectCurrent = $derived(
		currentProfileId !== null &&
			!profiles.some((profile) => profile.active),
	);

	async function refresh(): Promise<void> {
		try {
			profiles = await callMethod("profile_list");
		} catch (error) {
			console.error("Could not load saved profiles", error);
		}
		try {
			const session = await callMethod("current_session");
			const rawId = (session as { profileId?: unknown } | null)
				?.profileId;
			currentProfileId = typeof rawId === "number" ? rawId : null;
		} catch (error) {
			console.error("Could not load current session", error);
			currentProfileId = null;
		}
		// Passive refresh: the menu shows fresh per-profile counts, while
		// the background poller is the one that toasts about new arrivals.
		void refreshOtherSessionsUnread({ notify: false }).catch(() => {});
		void refreshSecondaryStatus().catch(() => {});
	}

	onMount(() => {
		void refresh();
		if (webBackendEnabled) {
			void adminMe()
				.then((me) => (admin = me))
				.catch(() => undefined);
		}
		// The floating message balloon asks the main window to switch to
		// the session with new messages when the user clicks Open.
		const stopListening = listen<{
			profileId: string;
			profileName: string;
		}>("bubble:open-profile", (event) => {
			const { profileId, profileName } = event.payload;
			if (typeof profileId !== "string" || profileId === "") return;
			const target = profiles.find((p) => p.profileId === profileId) ?? {
				profileId,
				name:
					typeof profileName === "string" && profileName !== ""
						? profileName
						: profileId,
				active: false,
			};
			if (target.active) {
				void goto("/", { invalidateAll: true });
				return;
			}
			void switchProfile(target);
		}).catch(() => () => {});
		return () => {
			void stopListening.then((stop) => stop());
		};
	});

	$effect(() => {
		if (open) void refresh();
	});

	async function switchProfile(profile: Profile): Promise<void> {
		if (busy || profile.active) return;
		busy = true;
		try {
			const geohash = await callMethod("profile_switch", {
				profileId: profile.profileId,
			});
			clearAccountCaches();
			await clearAccountPreferences();
			await setPreferences({ geohash });
			await goto("/", { invalidateAll: true });
			await refresh();
		} catch (error) {
			console.error("Could not switch profiles", error);
			toast.error("Could not switch profile");
		} finally {
			busy = false;
		}
	}

	async function disconnectProfile(profile: Profile): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			const original = profiles.find((p) => p.active);
			if (!profile.active) {
				await callMethod("profile_switch", {
					profileId: profile.profileId,
				});
			}
			await callMethod("sign_out");
			const remaining = (await callMethod("profile_list")).filter(
				(p) => p.profileId !== profile.profileId,
			);
			const next = profile.active
				? remaining[0]
				: remaining.find((p) => p.profileId === original?.profileId);
			clearAccountCaches();
			await clearAccountPreferences();
			if (next) {
				const geohash = await callMethod("profile_switch", {
					profileId: next.profileId,
				});
				await setPreferences({ geohash });
				await goto("/", { invalidateAll: true });
			} else {
				await goto("/auth/sign-in");
			}
			await refresh();
			toast.success(`Disconnected ${profile.name}`);
		} catch (error) {
			console.error("Could not disconnect profile", error);
			toast.error("Could not disconnect profile");
		} finally {
			busy = false;
		}
	}

	async function disconnectCurrent(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			await callMethod("sign_out");
			clearAccountCaches();
			await clearAccountPreferences();
			await goto("/auth/sign-in");
			await refresh();
			toast.success("Disconnected current profile");
		} catch (error) {
			console.error("Could not disconnect current profile", error);
			toast.error("Could not disconnect profile");
		} finally {
			busy = false;
		}
	}

	async function addProfile(): Promise<void> {
		if (busy || profiles.length >= maxProfiles) return;
		busy = true;
		try {
			await callMethod("profile_add");
			clearAccountCaches();
			await clearAccountPreferences();
			await goto("/auth/sign-in");
		} catch (error) {
			console.error("Could not start adding a profile", error);
			toast.error("Could not add another profile");
		} finally {
			busy = false;
		}
	}
</script>

{#if !demoEnabled}
	<DropdownMenu.Root bind:open>
		<DropdownMenu.Trigger>
			{#snippet child({ props: { class: className, ...props } })}
				<Button
					size="icon-lg"
					variant="ghost"
					class={[
						className,
						"relative h-14 w-16 shrink-0 flex-col gap-0.5",
					]}
					aria-label="Switch profile"
					disabled={busy}
					{...props}
				>
					<ArrowsLeftRightIcon weight="fill" class="size-5" />
					<span class="text-xs">Profiles</span>
					{#if otherSessionsUnread.total > 0}
						<Badge
							class="absolute end-1 top-1 min-w-5 px-1 text-[11px]"
						>
							{otherSessionsUnread.total > 9
								? "9+"
								: otherSessionsUnread.total}
						</Badge>
					{/if}
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" class="w-64">
			<DropdownMenu.Label>Profiles</DropdownMenu.Label>
			{#each profiles as profile (profile.profileId)}
				<DropdownMenu.Item
					disabled={busy || profile.active}
					onSelect={() => void switchProfile(profile)}
				>
					{#if profile.active}
						<CheckIcon class="size-4" weight="bold" />
					{:else}
						<span class="size-4" aria-hidden="true"></span>
					{/if}
					<span class="truncate">{profile.name}</span>
					{#if !profile.active && secondarySessions.isOnline(profile.profileId)}
						<span
							class="size-2 shrink-0 rounded-full bg-emerald-500"
							title="Online in the background"
							aria-label="Online in the background"
						></span>
					{/if}
					{#if !profile.active && otherSessionsUnread.unreadFor(profile.profileId) > 0}
						<Badge variant="secondary" class="ms-auto">
							{otherSessionsUnread.unreadFor(profile.profileId) >
							9
								? "9+"
								: otherSessionsUnread.unreadFor(
										profile.profileId,
									)}
						</Badge>
					{/if}
					{#if profile.active}
						<span class="ms-auto text-xs text-muted-foreground"
							>Active</span
						>
					{/if}
				</DropdownMenu.Item>
				<DropdownMenu.Item
					class="text-destructive"
					disabled={busy}
					onSelect={() => void disconnectProfile(profile)}
				>
					<SignOutIcon class="size-4" />
					<span class="truncate">Disconnect {profile.name}</span>
				</DropdownMenu.Item>
			{/each}
			{#if showDisconnectCurrent}
				<DropdownMenu.Item
					class="text-destructive"
					disabled={busy}
					onSelect={() => void disconnectCurrent()}
				>
					<SignOutIcon class="size-4" />
					<span class="truncate">Disconnect current profile</span>
				</DropdownMenu.Item>
			{/if}
			<DropdownMenu.Separator />
			<DropdownMenu.Item
				disabled={busy || profiles.length >= maxProfiles}
				onSelect={() => void addProfile()}
			>
				<PlusIcon class="size-4" />
				Add another account
				<span class="ms-auto text-xs text-muted-foreground">
					{profiles.length}/{maxProfiles}
				</span>
			</DropdownMenu.Item>
			{#if webBackendEnabled && admin}
				<DropdownMenu.Separator />
				<DropdownMenu.Label>Admin: {admin.username}</DropdownMenu.Label>
				{#if admin.isSuper}
					<DropdownMenu.Item onSelect={() => openCreateAdminDialog()}>
						<ShieldCheckIcon class="size-4" />
						Criar outro admin
					</DropdownMenu.Item>
				{/if}
				<DropdownMenu.Item onSelect={() => void adminLogout()}>
					<SignOutIcon class="size-4" />
					Sair do admin
				</DropdownMenu.Item>
			{/if}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/if}
