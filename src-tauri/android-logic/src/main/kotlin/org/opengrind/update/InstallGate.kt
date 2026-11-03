package org.opengrind.update

object InstallGate {
	const val RELEASE_CERT_SHA256 =
		"2805FDD8F0BADB9424D3244C5E5B3473CEF5B8798EC1117382E89EDA45C3658C"

	val EXTERNAL_UPDATERS = setOf(
		"org.fdroid.fdroid",
		"org.fdroid.fdroid.privileged",
		"org.fdroid.basic",
		"com.looker.droidify",
		"com.machiav3lli.fdroid",
		"dev.imranr.obtainium",
		"dev.imranr.obtainium.fdroid",
		"com.aurora.store",
		"com.android.vending",
	)

	sealed interface Verdict {
		data object Supported : Verdict

		data class ExternallyManaged(val installer: String) : Verdict

		data object ForeignSigner : Verdict

		data object ForeignTarget : Verdict
	}

	const val SIGNATURE_MATCH = 0
	const val SIGNATURE_UNKNOWN_PACKAGE = -4

	enum class TargetSigner {
		NotInstalled,
		Shared,
		Foreign,
		;

		companion object {
			fun of(signatureCheck: Int): TargetSigner = when (signatureCheck) {
				SIGNATURE_MATCH -> Shared
				SIGNATURE_UNKNOWN_PACKAGE -> NotInstalled
				else -> Foreign
			}
		}
	}

	fun decide(
		signerSha256: String?,
		target: String,
		targetSigner: TargetSigner,
		installer: () -> String?,
		updateOwner: () -> String?,
		self: String,
	): Verdict {
		if (signerSha256 == null || !matchesReleaseCert(signerSha256)) {
			return Verdict.ForeignSigner
		}
		if (target != self && targetSigner == TargetSigner.Foreign) {
			return Verdict.ForeignTarget
		}
		if (targetSigner == TargetSigner.NotInstalled) {
			return Verdict.Supported
		}
		val owningUpdates = updateOwner()
		if (owningUpdates != null && owningUpdates != self) {
			return Verdict.ExternallyManaged(owningUpdates)
		}
		val installedBy = installer()
		if (installedBy != null && installedBy in EXTERNAL_UPDATERS) {
			return Verdict.ExternallyManaged(installedBy)
		}
		return Verdict.Supported
	}

	fun matchesReleaseCert(fingerprint: String): Boolean =
		constantTimeEquals(fingerprint, RELEASE_CERT_SHA256)

	fun mayReplace(
		installedCode: Long?,
		archiveCode: Long,
	): Boolean = installedCode == null || archiveCode >= installedCode

	private fun constantTimeEquals(
		left: String,
		right: String,
	): Boolean {
		if (left.length != right.length) return false
		var difference = 0
		for (index in left.indices) {
			difference = difference or (left[index].code xor right[index].code)
		}
		return difference == 0
	}
}
