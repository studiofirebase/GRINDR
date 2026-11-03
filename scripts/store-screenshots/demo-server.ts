import type { BrowserContext } from "@playwright/test";

import playwrightConfig from "../../playwright.config";

const REPO_ROOT = Bun.fileURLToPath(new URL("../..", import.meta.url));
const TEST_ONLY_ENV = ["PUBLIC_TEST_INSETS"];
const SERVER_START_TIMEOUT_MS = 120_000;

function demoServerConfig() {
	const { webServer } = playwrightConfig;
	if (
		!webServer ||
		Array.isArray(webServer) ||
		!webServer.port ||
		!webServer.env
	) {
		throw new Error(
			"playwright.config.ts must declare one webServer with a port and env",
		);
	}
	return {
		command: webServer.command,
		port: webServer.port,
		env: webServer.env,
	};
}

function freePort(): number {
	const probe = Bun.serve({ port: 0, fetch: () => new Response() });
	const { port } = probe;
	void probe.stop(true);
	if (port === undefined) throw new Error("No free port for the demo server");
	return port;
}

export async function startDemoServer() {
	const config = demoServerConfig();
	const port = freePort();
	const command = config.command
		.split(" ")
		.map((token) => (token === String(config.port) ? String(port) : token));
	if (!command.includes(String(port))) {
		throw new Error(
			`The playwright webServer command does not pass its port ${config.port}`,
		);
	}
	const env = Object.fromEntries(
		Object.entries(config.env).filter(
			([name]) => !TEST_ONLY_ENV.includes(name),
		),
	);
	const server = Bun.spawn(command, {
		cwd: REPO_ROOT,
		env: { ...Bun.env, ...env },
		stdout: "ignore",
		stderr: "inherit",
	});
	const baseURL = `http://localhost:${port}`;
	const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (server.exitCode !== null) {
			throw new Error(
				`The demo server exited with code ${server.exitCode}`,
			);
		}
		const ready = await fetch(baseURL).then(
			(response) => response.ok,
			() => false,
		);
		if (ready) return { baseURL, stop: () => server.kill() };
		await Bun.sleep(250);
	}
	server.kill();
	throw new Error(`The demo server did not answer on ${baseURL}`);
}

export async function forwardOnlyDevServerErrors({
	context,
	baseURL,
}: {
	context: BrowserContext;
	baseURL: string;
}): Promise<void> {
	await context.routeWebSocket(
		`${baseURL.replace(/^http/, "ws")}/**`,
		(page) => {
			const server = page.connectToServer();
			server.onMessage((message) => {
				const { type } = JSON.parse(String(message)) as {
					type: string;
				};
				if (type === "error") page.send(message);
			});
		},
	);
}
