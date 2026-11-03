<script lang="ts">
	import { webBackendEnabled } from "$lib/web/bridge";
	const hasBackend = () => isTauri() || webBackendEnabled;
	import { isTauri } from "@tauri-apps/api/core";
	import StarIcon from "phosphor-svelte/lib/StarIcon";
	import { toast } from "svelte-sonner";

	import { callMethod } from "$lib/api/methods";
	import {
		enableAutomaticRepliesForProfiles,
		getAutomaticReplySettings,
		setAutomaticReplySettings,
	} from "$lib/app-data/preferences.svelte";
	import QuickFilterButton from "$lib/components/filters/QuickFilterButton.svelte";
	import ProgressiveBlur from "$lib/components/shared/ProgressiveBlur.svelte";
	import { Button, buttonVariants } from "$lib/components/ui/button";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Switch } from "$lib/components/ui/switch";
	import { Textarea } from "$lib/components/ui/textarea";
	import * as ToggleGroup from "$lib/components/ui/toggle-group";
	import { demoEnabled } from "$lib/demo";
	import { isAndroidPlatform, isMobilePlatform } from "$lib/platform/os";
	import { topChrome } from "$lib/util/screen-chrome.svelte";
	import type { ConversationFilters } from "$lib/chat/conversation-filters.svelte";
	import type { ConversationFilterValues } from "$lib/model/messaging/conversation-filters";
	import DistanceQuickFilter from "./DistanceQuickFilter.svelte";
	import PositionQuickFilter from "./PositionQuickFilter.svelte";

	let {
		filters,
		ourProfileId,
		onchange,
		inert = false,
		locked = false,
	}: {
		filters: ConversationFilters;
		ourProfileId: number;
		onchange: (values: Partial<ConversationFilterValues>) => void;
		inert?: boolean;
		locked?: boolean;
	} = $props();

	const LABELLED_TOGGLES = [
		{ key: "unread", label: "Unread" },
		{ key: "online", label: "Online" },
		{ key: "rightNow", label: "Right now" },
	] as const;

	const values = $derived(filters.value);

	let open = $state({ distance: false, position: false, ai: false });
	let autoRepliesEnabled = $state(false);
	let includeDrawerMedia = $state(false);
	let instructions = $state("");
	let provider = $state<"openrouter" | "apple-intelligence">("openrouter");
	let editingEnabled = $state(false);
	let editingIncludeDrawerMedia = $state(false);
	let editingInstructions = $state("");
	let editingProvider = $state<"openrouter" | "apple-intelligence">(
		"openrouter",
	);
	let openrouterKeyInput = $state("");
	let openrouterKeyConfigured = $state(false);
	let savingOpenrouterKey = $state(false);
	let appleIntelligenceStatus = $state({
		available: false,
		message: "Checking Apple Intelligence availability…",
	});
	let savingAiSettings = $state(false);

	$effect(() => {
		const profileId = ourProfileId;
		let current = true;
		void getAutomaticReplySettings(profileId)
			.then((settings) => {
				if (!current) return;
				autoRepliesEnabled = settings.enabled;
				includeDrawerMedia = settings.includeDrawerMedia;
				instructions = settings.instructions;
				provider = settings.provider;
			})
			.catch(() => {
				if (current) toast.error("Could not load AI reply settings.");
			});
		if (isTauri() && !demoEnabled && !isAndroidPlatform()) {
			void callMethod("apple_intelligence_status")
				.then((status) => {
					if (current) appleIntelligenceStatus = status;
				})
				.catch(() => {
					if (!current) return;
					appleIntelligenceStatus = {
						available: false,
						message:
							"Apple Intelligence status could not be checked.",
					};
				});
		} else {
			appleIntelligenceStatus = {
				available: false,
				message: isAndroidPlatform()
					? "Apple Intelligence is not included in the Android app."
					: "Apple Intelligence is available only in the macOS desktop app.",
			};
		}
		if (hasBackend() && !demoEnabled) {
			void refreshOpenrouterKeyStatus();
		}
		return () => {
			current = false;
		};
	});

	function openAiSettings() {
		editingEnabled = autoRepliesEnabled;
		editingIncludeDrawerMedia = includeDrawerMedia;
		editingInstructions = instructions;
		editingProvider = isAndroidPlatform() ? "openrouter" : provider;
		openrouterKeyInput = "";
		void refreshOpenrouterKeyStatus();
		open.ai = true;
	}

	async function refreshOpenrouterKeyStatus(): Promise<boolean> {
		if (!hasBackend() || demoEnabled) return false;
		try {
			openrouterKeyConfigured = await callMethod(
				"openrouter_api_key_status",
			);
		} catch {
			openrouterKeyConfigured = false;
		}
		return openrouterKeyConfigured;
	}

	async function ensureOpenrouterKeyConfigured(): Promise<boolean> {
		if (!hasBackend() || demoEnabled || editingProvider !== "openrouter")
			return true;
		if (await refreshOpenrouterKeyStatus()) return true;
		toast.error("Set an OpenRouter API key before enabling AI replies.");
		return false;
	}

	async function saveOpenrouterKey() {
		const apiKey = openrouterKeyInput.trim();
		if (!apiKey) return;
		savingOpenrouterKey = true;
		try {
			await callMethod("set_openrouter_api_key", { apiKey });
			openrouterKeyConfigured = true;
			openrouterKeyInput = "";
			toast.success("OpenRouter API key saved securely on this device.");
		} catch {
			toast.error("Could not save the OpenRouter API key securely.");
		} finally {
			savingOpenrouterKey = false;
		}
	}

	async function clearOpenrouterKey() {
		savingOpenrouterKey = true;
		try {
			await callMethod("clear_openrouter_api_key");
			openrouterKeyConfigured = false;
			openrouterKeyInput = "";
			toast.success("OpenRouter API key removed from this device.");
		} catch {
			toast.error("Could not remove the OpenRouter API key.");
		} finally {
			savingOpenrouterKey = false;
		}
	}

	async function saveAiSettings() {
		if (
			editingProvider === "apple-intelligence" &&
			!appleIntelligenceStatus.available
		) {
			toast.error(appleIntelligenceStatus.message);
			return;
		}
		if (editingEnabled && !(await ensureOpenrouterKeyConfigured())) return;
		savingAiSettings = true;
		try {
			const saved = await setAutomaticReplySettings(ourProfileId, {
				enabled: editingEnabled,
				includeDrawerMedia: editingIncludeDrawerMedia,
				instructions: editingInstructions,
				provider: editingProvider,
			});
			autoRepliesEnabled = saved.enabled;
			includeDrawerMedia = saved.includeDrawerMedia;
			instructions = saved.instructions;
			provider = saved.provider;
			open.ai = false;
		} catch {
			toast.error("Could not save AI reply settings.");
		} finally {
			savingAiSettings = false;
		}
	}

	async function enableAiForAllProfiles() {
		if (
			editingProvider === "apple-intelligence" &&
			!appleIntelligenceStatus.available
		) {
			toast.error(appleIntelligenceStatus.message);
			return;
		}
		if (!(await ensureOpenrouterKeyConfigured())) return;
		savingAiSettings = true;
		try {
			const profiles = await callMethod("profile_list");
			const profileIds = [
				...profiles.map((profile) => profile.profileId),
				String(ourProfileId),
			];
			await enableAutomaticRepliesForProfiles(profileIds, {
				profileId: ourProfileId,
				includeDrawerMedia: editingIncludeDrawerMedia,
				instructions: editingInstructions,
				provider: editingProvider,
			});
			autoRepliesEnabled = true;
			includeDrawerMedia = editingIncludeDrawerMedia;
			instructions = editingInstructions.trim();
			provider = editingProvider;
			open.ai = false;
			toast.success(
				`Automatic AI replies enabled for ${new Set(profileIds).size} saved profiles.`,
			);
		} catch {
			toast.error("Could not enable automatic replies for all profiles.");
		} finally {
			savingAiSettings = false;
		}
	}
</script>

<ProgressiveBlur
	direction="topToBottom"
	data-fixed-header
	class="absolute inset-x-0 top-0 z-10"
	bgClass="bg-linear-to-b from-background to-transparent"
	contentClass="scrollbar-thin flex gap-0.5 overflow-x-auto px-4 pt-4 pb-2"
	contentScrollIntent="x"
	{inert}
	{@attach !inert && topChrome}
>
	<div class="contents" inert={locked}>
		<ToggleGroup.Root
			type="multiple"
			variant="default"
			size="sm"
			class="h-9"
			bind:value={
				() => (values.favorites ? ["favorites"] : []),
				(active: string[]) =>
					onchange({ favorites: active.includes("favorites") })
			}
		>
			<ToggleGroup.Item
				value="favorites"
				aria-label="Favorites only"
				class={buttonVariants({ variant: "secondary" })}
			>
				<StarIcon weight={values.favorites ? "fill" : "bold"} />
			</ToggleGroup.Item>
		</ToggleGroup.Root>
		<ToggleGroup.Root
			type="multiple"
			variant="default"
			size="sm"
			class="h-9"
			bind:value={
				() =>
					LABELLED_TOGGLES.filter(({ key }) => values[key]).map(
						({ key }) => key,
					),
				(active: string[]) =>
					onchange({
						unread: active.includes("unread"),
						online: active.includes("online"),
						rightNow: active.includes("rightNow"),
					})
			}
		>
			{#each LABELLED_TOGGLES as { key, label } (key)}
				<ToggleGroup.Item
					value={key}
					class={buttonVariants({ variant: "secondary" })}
				>
					{label}
				</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>
		<QuickFilterButton
			active={values.distanceMetres !== null}
			onclick={() => (open.distance = true)}
		>
			Distance
		</QuickFilterButton>
		<QuickFilterButton
			active={values.positions.length > 0}
			onclick={() => (open.position = true)}
		>
			Position
		</QuickFilterButton>
		<QuickFilterButton
			active={autoRepliesEnabled}
			onclick={openAiSettings}
			label="Automatic AI replies"
		>
			IA
		</QuickFilterButton>
	</div>
</ProgressiveBlur>

<DistanceQuickFilter
	bind:open={open.distance}
	distanceMetres={values.distanceMetres}
	onapply={(distanceMetres) => onchange({ distanceMetres })}
/>
<PositionQuickFilter
	bind:open={open.position}
	positions={values.positions}
	onapply={(positions) => onchange({ positions })}
/>
<Dialog.Root bind:open={open.ai}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Automatic AI replies</Dialog.Title>
			<Dialog.Description>
				When enabled, the first incoming text and recent conversation
				messages are sent to the selected AI provider to draft a reply,
				and that reply is sent automatically from this profile. Leave
				this off unless you want automatic sending.
			</Dialog.Description>
		</Dialog.Header>
		<div class="grid gap-4">
			<div class="grid gap-2">
				<Label>AI provider</Label>
				<div class="flex flex-wrap gap-2">
					<Button
						variant={editingProvider === "openrouter"
							? "default"
							: "outline"}
						disabled={savingAiSettings}
						onclick={() => (editingProvider = "openrouter")}
					>
						OpenRouter
					</Button>
					{#if !isAndroidPlatform()}
						<Button
							variant={editingProvider === "apple-intelligence"
								? "default"
								: "outline"}
							disabled={savingAiSettings ||
								!appleIntelligenceStatus.available}
							onclick={() =>
								(editingProvider = "apple-intelligence")}
						>
							Apple Intelligence
						</Button>
					{/if}
				</div>
				<p class="text-xs text-muted-foreground">
					{#if editingProvider === "apple-intelligence"}
						{appleIntelligenceStatus.message} Messages and reply directions
						stay on this Mac.
					{:else}
						OpenRouter sends conversation text and reply directions
						to its cloud service.
					{/if}
				</p>
			</div>
			{#if isTauri() && !demoEnabled && isMobilePlatform() && editingProvider === "openrouter"}
				<div class="grid gap-2 rounded-lg border p-3">
					<Label for="openrouter-api-key">OpenRouter API key</Label>
					<Input
						id="openrouter-api-key"
						bind:value={openrouterKeyInput}
						type="password"
						autocomplete="off"
						autocapitalize="off"
						spellcheck={false}
						maxlength={512}
						placeholder="Paste your OpenRouter key"
					/>
					<div class="flex flex-wrap items-center gap-2">
						<Button
							variant="outline"
							disabled={savingOpenrouterKey ||
								!openrouterKeyInput.trim()}
							onclick={() => void saveOpenrouterKey()}
						>
							{openrouterKeyConfigured
								? "Update key"
								: "Save key"}
						</Button>
						{#if openrouterKeyConfigured}
							<Button
								variant="ghost"
								disabled={savingOpenrouterKey}
								onclick={() => void clearOpenrouterKey()}
							>
								Remove key
							</Button>
						{/if}
						<span class="text-xs text-muted-foreground">
							{openrouterKeyConfigured
								? "A key is saved securely on this device."
								: "No key is saved on this device."}
						</span>
					</div>
				</div>
			{/if}
			<Label class="flex items-start gap-3">
				<Switch bind:checked={editingEnabled} />
				<span class="grid gap-1">
					<span class="font-medium">Enable automatic replies</span>
					<span class="text-muted-foreground">
						Replies are sent without review while enabled.
					</span>
				</span>
			</Label>
			<div class="grid gap-2">
				<Label class="flex items-start gap-3">
					<Switch bind:checked={editingIncludeDrawerMedia} />
					<span class="grid gap-1">
						<span class="font-medium">Send all saved media</span>
						<span class="text-muted-foreground">
							Also sends every photo and video in the media drawer
							once per conversation, as separate messages.
						</span>
					</span>
				</Label>
			</div>
			<div class="grid gap-2">
				<Label for="automatic-reply-instructions">
					Reply directions
				</Label>
				<Textarea
					id="automatic-reply-instructions"
					bind:value={editingInstructions}
					maxlength={2000}
					placeholder="For example: keep it warm and brief; ask one thoughtful question."
					class="min-h-28 resize-y"
				/>
				<p class="text-xs text-muted-foreground">
					Optional style preferences. They cannot override safety
					boundaries. Your directions and recent text messages go to
					the selected provider when an eligible message arrives.
				</p>
			</div>
			{#if hasBackend() && !demoEnabled}
				<div class="grid gap-2 border-t pt-4">
					<Button
						variant="outline"
						disabled={savingAiSettings ||
							editingInstructions.length > 2000}
						onclick={() => void enableAiForAllProfiles()}
					>
						Enable AI for all saved profiles
					</Button>
					<p class="text-xs text-muted-foreground">
						This keeps replies enabled when you switch profiles. On
						app startup, Open Grind checks unread conversations in
						each saved profile one at a time, then restores the
						selected profile. Each profile keeps its own provider,
						reply directions, and media setting.
					</p>
				</div>
			{/if}
		</div>
		<Dialog.Footer>
			<Button
				variant="secondary"
				disabled={savingAiSettings}
				onclick={() => (open.ai = false)}
			>
				Cancel
			</Button>
			<Button
				disabled={savingAiSettings || editingInstructions.length > 2000}
				onclick={() => void saveAiSettings()}
			>
				{editingEnabled && !autoRepliesEnabled
					? "Enable automatic replies"
					: "Save"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
