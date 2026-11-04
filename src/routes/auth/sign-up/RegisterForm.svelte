<script lang="ts">
	import SmileySadIcon from "phosphor-svelte/lib/SmileySadIcon";

	import * as Alert from "$lib/components/ui/alert";
	import { Button } from "$lib/components/ui/button";
	import Link from "$lib/components/ui/link/Link.svelte";
	import { openExternalLink } from "$lib/platform/link-opener";
	import { isAndroidPlatform } from "$lib/platform/os";

	// Account creation needs captcha, phone/SMS, and email/age
	// verification, so it only works inside the official Grindr app.
	// Open Grind cannot register accounts via web (see #21).
	const GRINDR_DOWNLOAD_URL = "https://www.grindr.com/download";
	const GRINDR_PLAY_STORE_URL =
		"https://play.google.com/store/apps/details?id=com.grindrapp.android";

	const isAndroid = isAndroidPlatform();
	// On Android a direct Play Store link opens the store app; everywhere
	// else the official download page picks the right store.
	const storeUrl = isAndroid ? GRINDR_PLAY_STORE_URL : GRINDR_DOWNLOAD_URL;
</script>

<Alert.Root class="m-auto w-full max-w-sm">
	<SmileySadIcon size="2em" color="#ffba20" weight="fill" />
	<Alert.Title>Create your account on Grindr</Alert.Title>
	<Alert.Description>
		<p>
			Grindr requires captcha, email and age verification, so accounts can
			only be created in the official Grindr app (tracked in
			<Link
				href="https://git.opengrind.org/open-grind/open-grind/issues/21"
			>
				#21
			</Link>). Open Grind does not register accounts via web.
		</p>
		<ol class="mbs-2 list-decimal space-y-1 ps-5 text-start">
			<li>Install the official Grindr app.</li>
			<li>
				Create your account there (name, phone, email, password and SMS
				code).
			</li>
			<li>Come back here and sign in with your email or Google.</li>
		</ol>
		{#if isAndroid}
			<p class="mbs-2">
				Keep the official app installed: sign-in captcha verification
				needs it on this device.
			</p>
		{/if}
		<Button
			type="button"
			class="mbs-2 block w-full"
			onclick={() => openExternalLink(storeUrl)}
		>
			Get the official Grindr app
		</Button>
		{#if isAndroid}
			<Button
				type="button"
				variant="outline"
				class="mbs-1 block w-full"
				onclick={() => openExternalLink(GRINDR_DOWNLOAD_URL)}
			>
				Other download options
			</Button>
		{/if}
		<Button
			variant="link"
			href="/auth/sign-in"
			class="mbs-1 block size-fit px-0"
		>
			I already registered — Sign In
		</Button>
	</Alert.Description>
</Alert.Root>
