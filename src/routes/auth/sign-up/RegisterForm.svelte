<script lang="ts">
	import SmileySadIcon from "phosphor-svelte/lib/SmileySadIcon";

	import * as Alert from "$lib/components/ui/alert";
	import { Button } from "$lib/components/ui/button";
	import Link from "$lib/components/ui/link/Link.svelte";
</script>

<Alert.Root class="m-auto w-full max-w-sm">
	<SmileySadIcon size="2em" color="#ffba20" weight="fill" />
	<Alert.Title>Create your account on Grindr</Alert.Title>
	<Alert.Description>
		<p>
			Grindr requires captcha, email and age verification, so accounts are
			created in the official Grindr app (name, phone, email, password and
			SMS code) (tracked in <Link
				href="https://git.opengrind.org/open-grind/open-grind/issues/21"
			>
				#21
			</Link>). After registering, sign in here with your email or Google.
		</p>
		<Button
			href="https://www.grindr.com/download"
			target="_blank"
			rel="noopener noreferrer"
			class="mbs-2 block w-full"
		>
			Get the official Grindr app
		</Button>
		<Button
			variant="link"
			href="/auth/sign-in"
			class="mbs-1 block size-fit px-0"
		>
			I already registered — Sign In
		</Button>
	</Alert.Description>
</Alert.Root>
