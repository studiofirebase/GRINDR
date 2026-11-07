import { callMethod } from "$lib/api/methods";

// Email + password account creation (issue #21). Runs before sign-in,
// when the account has no usable session yet. New accounts cannot sign
// in until their phone number is confirmed, so callers must handle
// `verificationRequired` with the returned `profileId` via the SMS
// verification in `$lib/api/registration/sms`.

export async function createAccount({
	email,
	password,
	dateOfBirth,
	captchaToken,
}: {
	email: string;
	password: string;
	/** Milliseconds since the Unix epoch at UTC midnight. */
	dateOfBirth: number;
	captchaToken?: string;
}): Promise<{ profileId?: string | null; verificationRequired: boolean }> {
	return await callMethod("create_account", {
		email,
		password,
		dateOfBirth,
		captchaToken,
	});
}
