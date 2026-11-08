import { Container } from "@cloudflare/containers";

// Singleton: o app e stateful (sessoes e perfis em /data), entao todas as
// requisicoes vao para a mesma instancia. Use getRandom() apenas se um dia
// a persistencia for externa (R2/D1).
export class OpenGrindWeb extends Container {
	defaultPort = 8787;
	sleepAfter = "30m";
	enableInternet = true;
	pingEndpoint = "/api/health";

	/** Restart the running server once when its OpenRouter credential changes. */
	async syncOpenrouterKey(fingerprint: string): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			const previous = await this.ctx.storage.get<string>(
				"openrouter-key-fingerprint",
			);
			if (previous === fingerprint) return;

			// An initial missing key needs no restart. Adding, removing, or rotating
			// a key does, because start options are ignored while it is running.
			if (previous !== undefined || fingerprint !== "disabled") {
				await this.destroy();
				// destroy() can complete before the container's running flag clears.
				// startAndWaitForPorts() would then take its already-running fast path
				// and ignore the new environment variables.
				const stopDeadline = Date.now() + 15_000;
				while (this.container.running && Date.now() < stopDeadline) {
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
				if (this.container.running) {
					throw new Error(
						"Open Grind container did not stop to apply OpenRouter configuration",
					);
				}
			}
			await this.ctx.storage.put(
				"openrouter-key-fingerprint",
				fingerprint,
			);
		});
	}
}

interface Env {
	OPEN_GRIND_WEB: DurableObjectNamespace;
	OG_ORIGIN: string;
	OG_ADMIN_USER: string;
	OG_PASSWORD: string;
	// Segredo opcional: sem ele, /api/ai-status responde configured:false
	// e os recursos de IA ficam desligados.
	OPENROUTER_API_KEY?: string;
}

// Force the singleton onto the newly deployed web image once. Keep this value
// stable afterward so ordinary Worker uploads do not restart the container.
const OPENROUTER_KEY_SYNC_GENERATION = "2026-11-07-web-bundle-v5";

async function openrouterKeyFingerprint(
	key: string | undefined,
): Promise<string> {
	if (!key) return "disabled";
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(key),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const container = env.OPEN_GRIND_WEB.getByName("singleton");
		const openrouterKey = env.OPENROUTER_API_KEY?.trim();
		const keyFingerprint = await openrouterKeyFingerprint(openrouterKey);
		await container.syncOpenrouterKey(
			openrouterKey
				? `${keyFingerprint}:${OPENROUTER_KEY_SYNC_GENERATION}`
				: keyFingerprint,
		);
		// fetch() (nao containerFetch()) para suportar o upgrade de WebSocket
		// usado pelo /api/ws. startAndWaitForPorts espera a porta 8787 antes
		// de encaminhar, evitando "connection refused" no cold start.
		await container.startAndWaitForPorts({
			ports: [8787],
			startOptions: {
				envVars: {
					OG_ORIGIN: env.OG_ORIGIN,
					OG_ADMIN_USER: env.OG_ADMIN_USER,
					OG_PASSWORD: env.OG_PASSWORD,
					...(openrouterKey
						? { OPENROUTER_API_KEY: openrouterKey }
						: {}),
				},
			},
		});
		return container.fetch(request);
	},
};
