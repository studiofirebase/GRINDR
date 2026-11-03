import { Container } from "@cloudflare/containers";

// Singleton: o app e stateful (sessoes e perfis em /data), entao todas as
// requisicoes vao para a mesma instancia. Use getRandom() apenas se um dia
// a persistencia for externa (R2/D1).
export class OpenGrindWeb extends Container {
	defaultPort = 8787;
	sleepAfter = "30m";
	enableInternet = true;
	pingEndpoint = "/api/health";
}

interface Env {
	OPEN_GRIND_WEB: DurableObjectNamespace;
	OG_ORIGIN: string;
	OG_ADMIN_USER: string;
	OG_PASSWORD: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const container = env.OPEN_GRIND_WEB.getByName("singleton");
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
				},
			},
		});
		return container.fetch(request);
	},
};
