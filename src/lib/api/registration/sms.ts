import { callMethod } from "$lib/api/methods";

// Phone (SMS) verification for accounts created with email and password.
// Grindr only lets those accounts sign in after they confirm a one-time
// code sent by SMS. The commands below run before sign-in, when the
// account has no usable session yet.

export async function sendSmsVerificationCode({
	profileId,
	phoneNumber,
}: {
	profileId: string;
	phoneNumber: string;
}): Promise<unknown> {
	return await callMethod("sms_send_code", { profileId, phoneNumber });
}

export async function verifySmsCode({
	profileId,
	code,
}: {
	profileId: string;
	code: string;
}): Promise<unknown> {
	return await callMethod("sms_verify_code", { profileId, code });
}
