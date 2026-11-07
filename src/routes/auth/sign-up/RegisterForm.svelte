<script lang="ts">
	import { toast } from "svelte-sonner";
	import { SvelteDate } from "svelte/reactivity";

	import { showErrorToast } from "$lib/api/error-toast";
	import { asAppError, callMethod } from "$lib/api/methods";
	import { createAccount } from "$lib/api/registration/account";
	import PhoneVerificationForm from "$lib/components/feedback/PhoneVerificationForm.svelte";
	import { Button } from "$lib/components/ui/button";
	import * as Card from "$lib/components/ui/card";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Spinner } from "$lib/components/ui/spinner";
	import { openExternalLink } from "$lib/platform/link-opener";
	import { isAndroidPlatform } from "$lib/platform/os";

	const GRINDR_DOWNLOAD_URL = "https://www.grindr.com/download";
	const GRINDR_PLAY_STORE_URL =
		"https://play.google.com/store/apps/details?id=com.grindrapp.android";

	const isAndroid = isAndroidPlatform();
	const storeUrl = isAndroid ? GRINDR_PLAY_STORE_URL : GRINDR_DOWNLOAD_URL;

	type Step = "details" | "creating" | "sms" | "done" | "captcha";

	let step = $state<Step>("details");
	let email = $state("");
	let password = $state("");
	let confirmPassword = $state("");
	let dateOfBirth = $state("");
	let formError = $state<string | null>(null);
	let profileId = $state("");

	const adultCutoff = (() => {
		const cutoff = new SvelteDate();
		cutoff.setFullYear(cutoff.getFullYear() - 18);
		return cutoff.toISOString().slice(0, 10);
	})();

	function dateOfBirthMillis(value: string): number | null {
		const millis = Date.parse(`${value}T00:00:00Z`);
		if (Number.isNaN(millis)) return null;
		if (millis > Date.parse(`${adultCutoff}T00:00:00Z`)) return null;
		return millis;
	}

	async function submitDetails(event: SubmitEvent) {
		event.preventDefault();
		formError = null;
		if (password !== confirmPassword) {
			formError = "Passwords do not match.";
			return;
		}
		const millis = dateOfBirthMillis(dateOfBirth);
		if (millis === null) {
			formError = "You must be 18 or older to create an account.";
			return;
		}
		step = "creating";
		try {
			const captchaToken = await mintSignUpToken().catch(() => undefined);
			const created = await createAccount({
				email,
				password,
				dateOfBirth: millis,
				captchaToken,
			});
			if (created.verificationRequired && created.profileId) {
				profileId = created.profileId;
				toast.success(
					"Account created. Verify your phone number to finish.",
				);
				step = "sms";
				return;
			}
			if (!created.verificationRequired) {
				step = "done";
				return;
			}
			throw new Error("The server did not return a profile to verify.");
		} catch (error) {
			if (asAppError(error)?.kind === "Recaptcha") {
				step = "captcha";
				return;
			}
			showErrorToast({ label: "Couldn't create the account", error });
			step = "details";
		}
	}

	async function mintSignUpToken(): Promise<string> {
		return await callMethod("mint_recaptcha_token", { action: "sign_up" });
	}

	function verified() {
		step = "done";
	}
</script>

<Card.Root class="m-auto w-full max-w-sm">
	<Card.Header>
		<Card.Title>Create your Grindr account</Card.Title>
		<Card.Description>
			{#if step === "sms"}
				Almost done — confirm the code we sent by SMS.
			{:else if step === "done"}
				Your account is ready.
			{:else}
				Enter your email below to create your account
			{/if}
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{#if step === "details" || step === "creating"}
			<form onsubmit={submitDetails} class="contents">
				<div class="flex flex-col gap-6">
					<div class="grid gap-2">
						<Label for="signup-email">Email</Label>
						<Input
							id="signup-email"
							type="email"
							placeholder="m@example.com"
							required
							autocomplete="email"
							bind:value={email}
							disabled={step !== "details"}
						/>
					</div>
					<div class="grid gap-2">
						<Label for="signup-password">Password</Label>
						<Input
							id="signup-password"
							type="password"
							required
							autocomplete="new-password"
							bind:value={password}
							disabled={step !== "details"}
						/>
					</div>
					<div class="grid gap-2">
						<Label for="signup-confirm-password"
							>Confirm password</Label
						>
						<Input
							id="signup-confirm-password"
							type="password"
							required
							autocomplete="new-password"
							bind:value={confirmPassword}
							disabled={step !== "details"}
						/>
					</div>
					<div class="grid gap-2">
						<Label for="signup-birthdate">Date of birth</Label>
						<Input
							id="signup-birthdate"
							type="date"
							required
							max={adultCutoff}
							bind:value={dateOfBirth}
							disabled={step !== "details"}
						/>
						<p class="text-sm text-muted-foreground">
							You must be 18 or older.
						</p>
					</div>
					{#if formError}
						<p class="text-sm text-destructive">{formError}</p>
					{/if}
				</div>
				<Button
					type="submit"
					class="mt-6 w-full"
					disabled={step !== "details"}
					aria-busy={step === "creating"}
				>
					{#if step === "creating"}
						<Spinner aria-hidden="true" />
					{/if}
					Create account
				</Button>
			</form>
			<p class="mt-4 text-center text-sm text-muted-foreground">
				Prefer Google or Facebook? They create your account directly
				from the
				<Button variant="link" href="/auth/sign-in" class="px-1">
					sign-in page
				</Button>
			</p>
		{:else if step === "sms"}
			<PhoneVerificationForm {profileId} onVerified={verified} />
		{:else if step === "done"}
			<p class="text-sm">
				Your account was created
				{#if profileId}
					and your phone number was verified
				{/if}. Sign in with your email and password to get started.
			</p>
			<Button href="/auth/sign-in" class="mt-4 w-full">Sign in</Button>
		{:else if step === "captcha"}
			<p class="text-sm">
				Grindr asked for captcha verification, which needs the Open
				Grind reCAPTCHA helper on Android with the official Grindr app
				installed. Create your account there instead, then sign in here.
			</p>
			<Button
				type="button"
				class="mt-4 w-full"
				onclick={() => openExternalLink(storeUrl)}
			>
				Get the official Grindr app
			</Button>
			<Button
				type="button"
				variant="outline"
				class="mt-2 w-full"
				onclick={() => {
					step = "details";
				}}
			>
				Back to the form
			</Button>
		{/if}
	</Card.Content>
	<Card.Footer class="flex-col gap-2">
		{#if step === "details"}
			<Button variant="link" href="/auth/sign-in" class="px-0">
				I already registered — Sign In
			</Button>
		{/if}
	</Card.Footer>
</Card.Root>
