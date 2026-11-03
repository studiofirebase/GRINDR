import { decode, encode } from "@msgpack/msgpack";
import { isTauri } from "@tauri-apps/api/core";
import { toast } from "svelte-sonner";
import z from "zod";

import {
	awaitBackgroundSwapEnd,
	backgroundSessionSwapInFlight,
	swapSettleWaitMs,
} from "$lib/api/background-session-swap";
import { callMethod } from "$lib/api/methods";
import { backdropBlurCalibrationSchema } from "$lib/blur/calibration/decide";
import { backdropBlurQualitySchema } from "$lib/blur/quality";
import { demoEnabled } from "$lib/demo";
import { gridSearchFiltersSchema } from "$lib/model/browse/grid/filters";
import { geohashSchema } from "$lib/model/geohash";
import { isAndroidPlatform } from "$lib/platform/os";
import { unitSystemSchema } from "$lib/util/units";
import {
	existsAppDataFile,
	readAppDataFile,
	removeAppDataFile,
	writeAppDataFileAtomic,
} from ".";

const preferencesSchema = z.object({
	autoUpdateLocation: z.boolean().default(false),
	autoReplyProfiles: z
		.record(
			z.string(),
			z.object({
				enabled: z.boolean().default(false),
				includeDrawerMedia: z.boolean().default(false),
				instructions: z.string().max(2000).default(""),
				provider: z
					.enum(["openrouter", "apple-intelligence"])
					.default("openrouter"),
				revision: z.number().int().nonnegative().default(0),
				handledMessageIds: z.array(z.string()).default([]),
				mediaSentConversationIds: z.array(z.string()).default([]),
			}),
		)
		.default({}),
	backdropBlurCalibration: backdropBlurCalibrationSchema
		.nullable()
		.default(null)
		.catch(null),
	backdropBlurQuality: backdropBlurQualitySchema
		.nullable()
		.default(null)
		.catch(null),
	geohash: geohashSchema.nullable().default(null),
	giphyConsent: z.boolean().default(false),
	hapticFeedback: z.boolean().default(true),
	onboardingComplete: z.boolean().default(false),
	gridSearchFilters: gridSearchFiltersSchema.optional(),
	notificationsEnabled: z.boolean().default(false),
	revealMessageRead: z.boolean().default(false),
	revealProfileViews: z.boolean().default(false),
	stayOnline: z.boolean().default(true),
	units: unitSystemSchema.default("metric"),
});

type Preferences = z.infer<typeof preferencesSchema>;

export type BooleanPreference = {
	[Key in keyof Preferences]-?: Preferences[Key] extends boolean
		? Key
		: never;
}[keyof Preferences];

let writeQueue: Promise<unknown> = Promise.resolve();
let snapshot = $state<Preferences>(preferencesSchema.parse({}));
let loaded = $state(false);

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
	const run = writeQueue.then(task);
	writeQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

export type AutomaticReplySettings = {
	enabled: boolean;
	includeDrawerMedia: boolean;
	instructions: string;
	provider: AiReplyProvider;
	revision: number;
};

export type AiReplyProvider = "openrouter" | "apple-intelligence";

let cache: Preferences | null = null;
let hydrating: Promise<Preferences> | null = null;

function publish(preferences: Preferences): void {
	cache = preferences;
	snapshot = preferences;
	loaded = true;
}

async function readFromDisk(): Promise<Preferences> {
	if (!(await existsAppDataFile("preferences.data"))) {
		return preferencesSchema.parse({});
	}
	const bytes = await readAppDataFile("preferences.data");
	return preferencesSchema.parse(decode(bytes));
}

export async function getPreferences(): Promise<Preferences> {
	if (cache !== null) return structuredClone(cache);
	hydrating ??= readFromDisk()
		.then((preferences) => {
			publish(preferences);
			return preferences;
		})
		.catch((error: unknown) => {
			console.error(error);
			toast.error("Failed to load preferences. Reset to defaults?", {
				action: {
					label: "Reset",
					onClick: () => void resetToDefaults(),
				},
				duration: 10000,
				id: "load-preferences-error",
			});
			throw error;
		})
		.finally(() => {
			hydrating = null;
		});
	return structuredClone(await hydrating);
}

export function preferencesSnapshot(): Preferences {
	return snapshot;
}

export function preferencesLoaded(): boolean {
	return loaded;
}

export async function hydratePreferences(): Promise<void> {
	await getPreferences();
}

export async function setPreferences(
	newValues: Partial<Preferences>,
): Promise<void> {
	await enqueueWrite(async () => {
		const oldValues = await getPreferences();
		const preferences = preferencesSchema.parse({
			...oldValues,
			...newValues,
		});
		if ("geohash" in newValues && isTauri() && !demoEnabled) {
			// profile_set_location stores the location on the profile the
			// backend currently holds: never file it under another profile
			// while a background scan owns the session.
			if (
				backgroundSessionSwapInFlight() &&
				!(await awaitBackgroundSwapEnd(swapSettleWaitMs))
			) {
				throw new Error(
					"The app is finishing a background sync; try changing location again.",
				);
			}
			await callMethod("profile_set_location", {
				geohash: preferences.geohash,
			});
		}
		await writeAppDataFileAtomic({
			path: "preferences.data",
			content: encode(preferences),
		});
		publish(preferences);
	});
}

export async function getAutomaticReplySettings(
	profileId: string | number,
): Promise<AutomaticReplySettings> {
	const stored = (await getPreferences()).autoReplyProfiles[
		String(profileId)
	];
	return {
		enabled: stored?.enabled ?? false,
		includeDrawerMedia: stored?.includeDrawerMedia ?? false,
		instructions: stored?.instructions ?? "",
		provider: isAndroidPlatform()
			? "openrouter"
			: (stored?.provider ?? "openrouter"),
		revision: stored?.revision ?? 0,
	};
}

export async function setAutomaticReplySettings(
	profileId: string | number,
	values: Pick<
		AutomaticReplySettings,
		"enabled" | "includeDrawerMedia" | "instructions"
	> &
		Partial<Pick<AutomaticReplySettings, "provider">>,
): Promise<AutomaticReplySettings> {
	return enqueueWrite(async () => {
		const preferences = await getPreferences();
		const key = String(profileId);
		const previous = preferences.autoReplyProfiles[key];
		const settings = {
			enabled: values.enabled,
			includeDrawerMedia: values.includeDrawerMedia,
			instructions: values.instructions.trim(),
			provider: isAndroidPlatform()
				? "openrouter"
				: (values.provider ?? previous?.provider ?? "openrouter"),
			revision: (previous?.revision ?? 0) + 1,
			handledMessageIds: previous?.handledMessageIds ?? [],
			mediaSentConversationIds: previous?.mediaSentConversationIds ?? [],
		};
		const next = preferencesSchema.parse({
			...preferences,
			autoReplyProfiles: {
				...preferences.autoReplyProfiles,
				[key]: settings,
			},
		});
		await writeAppDataFileAtomic({
			path: "preferences.data",
			content: encode(next),
		});
		publish(next);
		return {
			enabled: settings.enabled,
			includeDrawerMedia: settings.includeDrawerMedia,
			instructions: settings.instructions,
			provider: settings.provider,
			revision: settings.revision,
		};
	});
}

/**
 * Enables startup replies for saved profiles that have no saved choice yet.
 * Existing per-profile settings, including an explicit opt-out, are kept.
 */
export async function enableAutomaticRepliesForUnconfiguredProfiles(
	profileIds: Array<string | number>,
): Promise<void> {
	return enqueueWrite(async () => {
		const preferences = await getPreferences();
		const autoReplyProfiles = { ...preferences.autoReplyProfiles };
		let changed = false;

		const uniqueProfileIds = profileIds
			.map(String)
			.filter(
				(profileId, index, ids) => ids.indexOf(profileId) === index,
			);

		for (const profileId of uniqueProfileIds) {
			if (
				Object.prototype.hasOwnProperty.call(
					autoReplyProfiles,
					profileId,
				)
			)
				continue;
			autoReplyProfiles[profileId] = {
				enabled: true,
				includeDrawerMedia: false,
				instructions: "",
				provider: "openrouter",
				revision: 1,
				handledMessageIds: [],
				mediaSentConversationIds: [],
			};
			changed = true;
		}

		if (!changed) return;
		const next = preferencesSchema.parse({
			...preferences,
			autoReplyProfiles,
		});
		await writeAppDataFileAtomic({
			path: "preferences.data",
			content: encode(next),
		});
		publish(next);
	});
}

export async function enableAutomaticRepliesForProfiles(
	profileIds: Array<string | number>,
	activeProfileSettings: Pick<
		AutomaticReplySettings,
		"includeDrawerMedia" | "instructions"
	> &
		Partial<Pick<AutomaticReplySettings, "provider">> & {
			profileId: string | number;
		},
): Promise<void> {
	return enqueueWrite(async () => {
		const preferences = await getPreferences();
		const activeProfileKey = String(activeProfileSettings.profileId);
		const autoReplyProfiles = { ...preferences.autoReplyProfiles };

		const uniqueProfileIds = profileIds
			.map(String)
			.filter(
				(profileId, index, ids) => ids.indexOf(profileId) === index,
			);

		for (const profileId of uniqueProfileIds) {
			const previous = autoReplyProfiles[profileId];
			const isActiveProfile = profileId === activeProfileKey;
			autoReplyProfiles[profileId] = {
				enabled: true,
				includeDrawerMedia: isActiveProfile
					? activeProfileSettings.includeDrawerMedia
					: (previous?.includeDrawerMedia ?? false),
				instructions: isActiveProfile
					? activeProfileSettings.instructions.trim()
					: (previous?.instructions ?? ""),
				provider: isActiveProfile
					? (activeProfileSettings.provider ??
						previous?.provider ??
						"openrouter")
					: (previous?.provider ?? "openrouter"),
				revision: (previous?.revision ?? 0) + 1,
				handledMessageIds: previous?.handledMessageIds ?? [],
				mediaSentConversationIds:
					previous?.mediaSentConversationIds ?? [],
			};
		}

		const next = preferencesSchema.parse({
			...preferences,
			autoReplyProfiles,
		});
		await writeAppDataFileAtomic({
			path: "preferences.data",
			content: encode(next),
		});
		publish(next);
	});
}

export async function claimAutomaticReply(
	profileId: string | number,
	messageId: string,
	expectedRevision?: number,
): Promise<boolean> {
	return enqueueWrite(async () => {
		const preferences = await getPreferences();
		const key = String(profileId);
		const stored = preferences.autoReplyProfiles[key];
		if (
			!stored?.enabled ||
			(expectedRevision !== undefined &&
				stored.revision !== expectedRevision) ||
			stored.handledMessageIds.includes(messageId)
		)
			return false;
		const next = preferencesSchema.parse({
			...preferences,
			autoReplyProfiles: {
				...preferences.autoReplyProfiles,
				[key]: {
					...stored,
					handledMessageIds: [...stored.handledMessageIds, messageId],
				},
			},
		});
		await writeAppDataFileAtomic({
			path: "preferences.data",
			content: encode(next),
		});
		publish(next);
		return true;
	});
}

export async function releaseAutomaticReplyClaim(
	profileId: string | number,
	messageId: string,
	expectedRevision?: number,
): Promise<boolean> {
	return enqueueWrite(async () => {
		const preferences = await getPreferences();
		const key = String(profileId);
		const stored = preferences.autoReplyProfiles[key];
		if (
			!stored ||
			(expectedRevision !== undefined &&
				stored.revision !== expectedRevision) ||
			!stored.handledMessageIds.includes(messageId)
		)
			return false;
		const next = preferencesSchema.parse({
			...preferences,
			autoReplyProfiles: {
				...preferences.autoReplyProfiles,
				[key]: {
					...stored,
					handledMessageIds: stored.handledMessageIds.filter(
						(id) => id !== messageId,
					),
				},
			},
		});
		await writeAppDataFileAtomic({
			path: "preferences.data",
			content: encode(next),
		});
		publish(next);
		return true;
	});
}

export async function claimAutomaticReplyMedia(
	profileId: string | number,
	conversationId: string,
	expectedRevision?: number,
): Promise<boolean> {
	return enqueueWrite(async () => {
		const preferences = await getPreferences();
		const key = String(profileId);
		const stored = preferences.autoReplyProfiles[key];
		if (
			!stored?.enabled ||
			!stored.includeDrawerMedia ||
			(expectedRevision !== undefined &&
				stored.revision !== expectedRevision) ||
			stored.mediaSentConversationIds.includes(conversationId)
		)
			return false;
		const next = preferencesSchema.parse({
			...preferences,
			autoReplyProfiles: {
				...preferences.autoReplyProfiles,
				[key]: {
					...stored,
					mediaSentConversationIds: [
						...stored.mediaSentConversationIds,
						conversationId,
					],
				},
			},
		});
		await writeAppDataFileAtomic({
			path: "preferences.data",
			content: encode(next),
		});
		publish(next);
		return true;
	});
}

async function resetToDefaults(): Promise<void> {
	await enqueueWrite(async () => {
		const preferences = preferencesSchema.parse({});
		await writeAppDataFileAtomic({
			path: "preferences.data",
			content: encode(preferences),
		});
		publish(preferences);
	});
	window.location.reload();
}

const accountPreferenceKeys = [
	"autoUpdateLocation",
	"geohash",
	"gridSearchFilters",
	"notificationsEnabled",
] as const;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export async function clearAccountPreferences(): Promise<void> {
	await enqueueWrite(async () => {
		const kept: Partial<Preferences> = { ...(await getPreferences()) };
		for (const key of accountPreferenceKeys) delete kept[key];
		const preferences = preferencesSchema.parse(kept);
		publish(preferences);
		const encoded = encode(preferences);
		if (bytesEqual(encoded, encode(preferencesSchema.parse({})))) {
			await removeAppDataFile("preferences.data");
		} else {
			await writeAppDataFileAtomic({
				path: "preferences.data",
				content: encoded,
			});
		}
	});
}
