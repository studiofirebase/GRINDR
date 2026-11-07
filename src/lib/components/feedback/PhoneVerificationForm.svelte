<script lang="ts">
	import { toast } from "svelte-sonner";

	import { showErrorToast } from "$lib/api/error-toast";
	import {
		sendSmsVerificationCode,
		verifySmsCode,
	} from "$lib/api/registration/sms";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Spinner } from "$lib/components/ui/spinner";

	let {
		profileId,
		onVerified,
	}: { profileId: string; onVerified: () => void } = $props();

	let phoneNumber = $state("");
	let code = $state("");
	let sent = $state(false);
	let busy: false | "send" | "verify" = $state(false);

	async function send(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		busy = "send";
		try {
			await sendSmsVerificationCode({ profileId, phoneNumber });
			sent = true;
			toast.success("Verification code sent. Check your messages.");
		} catch (error) {
			showErrorToast({ label: "Couldn't send the code", error });
		} finally {
			busy = false;
		}
	}

	async function verify(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		busy = "verify";
		try {
			await verifySmsCode({ profileId, code });
			toast.success("Phone number verified. Please sign in again.");
			onVerified();
		} catch (error) {
			showErrorToast({ label: "Couldn't verify the code", error });
		} finally {
			busy = false;
		}
	}
</script>

{#if !sent}
	<form onsubmit={send} class="mt-4 flex flex-col gap-2">
		<div class="grid gap-2 text-start">
			<Label for="phone-number">Phone number</Label>
			<Input
				id="phone-number"
				type="tel"
				placeholder="+15551234567"
				required
				autocomplete="tel"
				bind:value={phoneNumber}
				disabled={busy !== false}
			/>
		</div>
		<Button
			type="submit"
			class="w-full"
			disabled={busy !== false || phoneNumber.trim() === ""}
			aria-busy={busy === "send"}
		>
			{#if busy === "send"}
				<Spinner aria-hidden="true" />
			{/if}
			Send verification code
		</Button>
	</form>
{:else}
	<form onsubmit={verify} class="mt-4 flex flex-col gap-2">
		<div class="grid gap-2 text-start">
			<Label for="verification-code">Verification code</Label>
			<Input
				id="verification-code"
				type="text"
				inputmode="numeric"
				placeholder="123456"
				required
				autocomplete="one-time-code"
				bind:value={code}
				disabled={busy !== false}
			/>
		</div>
		<Button
			type="submit"
			class="w-full"
			disabled={busy !== false || code.trim() === ""}
			aria-busy={busy === "verify"}
		>
			{#if busy === "verify"}
				<Spinner aria-hidden="true" />
			{/if}
			Verify phone number
		</Button>
		<Button
			type="button"
			variant="link"
			class="w-full"
			disabled={busy !== false}
			onclick={() => {
				sent = false;
				code = "";
			}}
		>
			Use a different number
		</Button>
	</form>
{/if}
