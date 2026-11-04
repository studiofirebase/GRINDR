import { decode, encode } from "@msgpack/msgpack";

import { fromBase64, toBase64 } from "$lib/util/base64";

export const webBackendEnabled = import.meta.env.OPEN_GRIND_WEB === "1";

type Handler = (payload: unknown) => void;
type Args = Record<string, unknown>;

const callbacks = new Map<number, Handler>();
const listeners = new Map<number, { event: string; callbackId: number }>();
let nextId = 1;
let socket: WebSocket | null = null;
let wantSocket = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

class BackendError extends Error {
	constructor(
		readonly kind: string,
		message: string,
	) {
		super(message);
	}
}

function emit(event: string, payload: unknown): void {
	for (const [id, listener] of listeners) {
		if (listener.event !== event) continue;
		callbacks.get(listener.callbackId)?.({ event, id, payload });
	}
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		credentials: "same-origin",
		...init,
		headers: { "content-type": "application/json", ...init?.headers },
	});
	if (response.status === 401 && path !== "/api/login") {
		await askForPassword();
		return await api<T>(path, init);
	}
	const body = (await response.json().catch(() => ({}))) as {
		error?: string;
	};
	if (!response.ok) {
		const kind =
			response.status === 409 && body.error?.includes("active")
				? "NotSignedIn"
				: "Http";
		throw new BackendError(kind, body.error ?? `HTTP ${response.status}`);
	}
	return body as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
	return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

let passwordPrompt: Promise<void> | undefined;

const fieldStyle =
	"padding:10px;border-radius:8px;border:1px solid #444;background:#161616;color:#fff";
const buttonStyle =
	"padding:10px;border-radius:8px;border:0;background:#f5c400;color:#000;font-weight:600";

function askForPassword(): Promise<void> {
	passwordPrompt ??= new Promise<void>((resolve) => {
		const overlay = document.createElement("div");
		overlay.style.cssText =
			"position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#fff;font:16px system-ui";
		overlay.innerHTML = `<div style="display:grid;gap:12px;width:min(340px,90vw)">
			<strong>Open Grind — Admin</strong>
			<div style="display:flex;gap:8px">
				<button type="button" data-tab="login" style="${buttonStyle};flex:1">Entrar</button>
				<button type="button" data-tab="create" style="${fieldStyle};flex:1;cursor:pointer;opacity:.6">Criar conta</button>
			</div>
			<form data-login-form style="display:grid;gap:12px">
				<input name="username" autocomplete="username" autocapitalize="none" placeholder="Usuário admin" style="${fieldStyle}" />
				<input name="password" type="password" autocomplete="current-password" placeholder="Senha" style="${fieldStyle}" />
				<label style="display:flex;gap:8px;align-items:center;font-size:14px"><input name="remember" type="checkbox" checked /> Manter conectado</label>
				<button style="${buttonStyle}">Entrar</button>
				<small data-error style="color:#f87171"></small>
			</form>
			<form data-create-form style="display:none;gap:12px">
				<small style="color:#aaa">Crie seu acesso: voce administra apenas os seus proprios perfis.</small>
				<input name="newUsername" autocomplete="username" autocapitalize="none" placeholder="Novo usuário (a-z, 0-9, _ -)" style="${fieldStyle}" />
				<input name="newPassword" type="password" autocomplete="new-password" placeholder="Nova senha (mín. 8)" style="${fieldStyle}" />
				<label style="display:flex;gap:8px;align-items:center;font-size:14px"><input name="remember" type="checkbox" checked /> Manter conectado</label>
				<button style="${buttonStyle}">Criar e entrar</button>
				<small data-error style="color:#f87171"></small>
			</form></div>`;
		document.body.append(overlay);
		const loginForm = overlay.querySelector(
			"[data-login-form]",
		) as HTMLFormElement;
		const createForm = overlay.querySelector(
			"[data-create-form]",
		) as HTMLFormElement;
		const loginTab = overlay.querySelector(
			'[data-tab="login"]',
		) as HTMLButtonElement;
		const createTab = overlay.querySelector(
			'[data-tab="create"]',
		) as HTMLButtonElement;
		const loginError = loginForm.querySelector("[data-error]")!;
		const createError = createForm.querySelector("[data-error]")!;
		const showTab = (mode: "login" | "create") => {
			const isLogin = mode === "login";
			loginForm.style.display = isLogin ? "grid" : "none";
			createForm.style.display = isLogin ? "none" : "grid";
			loginTab.style.opacity = isLogin ? "1" : "0.6";
			createTab.style.opacity = isLogin ? "0.6" : "1";
			(isLogin ? loginForm : createForm).querySelector("input")?.focus();
		};
		loginTab.addEventListener("click", () => showTab("login"));
		createTab.addEventListener("click", () => showTab("create"));
		// POST direto, sem passar pelo interceptador de 401: aqui o
		// passwordPrompt atual ainda esta pendente e reutiliza-lo travaria.
		const rawPost = async <T>(path: string, body: unknown): Promise<T> => {
			const response = await fetch(path, {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const parsed = (await response.json().catch(() => ({}))) as {
				error?: string;
			} & T;
			if (!response.ok) {
				throw new Error(parsed.error ?? `HTTP ${response.status}`);
			}
			return parsed;
		};
		const done = () => {
			overlay.remove();
			passwordPrompt = undefined;
			resolve();
		};
		loginForm.querySelector("input")?.focus();
		loginForm.addEventListener("submit", (event) => {
			event.preventDefault();
			const field = (name: string) =>
				loginForm.elements.namedItem(name) as HTMLInputElement;
			void post("/api/login", {
				username: field("username").value,
				password: field("password").value,
				remember: field("remember").checked,
			})
				.then(() => {
					// Vai direto ao fluxo do app (ex.: login no Grindr).
					// Quem quiser criar outro admin usa a aba Criar conta
					// ou o menu Profiles > Criar outro admin.
					done();
				})
				.catch((cause: Error) => {
					loginError.textContent = cause.message;
				});
		});
		createForm.addEventListener("submit", (event) => {
			event.preventDefault();
			const field = (name: string) =>
				createForm.elements.namedItem(name) as HTMLInputElement;
			createError.textContent = "";
			// Registro público: cria um admin comum (nunca super) com
			// perfis próprios e isolados, sem pedir o admin principal.
			void rawPost("/api/register", {
				username: field("newUsername").value,
				password: field("newPassword").value,
				remember: field("remember").checked,
			})
				.then(() => {
					done();
				})
				.catch((cause: Error) => {
					createError.textContent = cause.message;
				});
		});
	});
	return passwordPrompt;
}

const GOOGLE_CLIENT_ID =
	"1036042917246-htcnf9mm3qnis86l47ngp0a9ncqsll7j.apps.googleusercontent.com";

// Runs on web.grindr.com, the only origin Google allows for Grindr's client id.
// The token goes straight to our server, so it never depends on window.opener.
function bookmarkletFor(key: string): string {
	return `javascript:(()=>{const s=document.createElement('script');s.src='https://accounts.google.com/gsi/client';s.onload=()=>{google.accounts.oauth2.initTokenClient({client_id:'${GOOGLE_CLIENT_ID}',scope:'email profile',callback:async r=>{const t=r.access_token;if(!t){alert('Google nao retornou token');return}try{const x=await fetch('${location.origin}/api/google-handoff',{method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify({key:'${key}',token:t})});const j=await x.json().catch(()=>({}));if(x.ok){alert('Conta conectada! Volte ao Open Grind.');window.close()}else alert('Falha: '+(j.error||x.status))}catch(e){alert('Erro de rede: '+e)}},error_callback:e=>alert('Google: '+(e&&e.type))}).requestAccessToken({prompt:'select_account'})};document.head.appendChild(s)})()`;
}

async function googleViaPopup(): Promise<string> {
	const { key } = await api<{ key: string }>("/api/google-key");
	const before = new Set(
		(await api<Profile[]>("/api/profiles")).map((p) => p.profileId),
	);
	const popupUrl = `https://web.grindr.com/#og=${key}@${location.origin}`;
	const popup = window.open(
		popupUrl,
		"og-google",
		"popup,width=520,height=720",
	);
	return await new Promise<string>((resolve, reject) => {
		const overlay = document.createElement("div");
		overlay.style.cssText =
			"position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.85);color:#fff;font:15px system-ui";
		overlay.innerHTML = `<div style="display:grid;gap:12px;width:min(360px,92vw);background:#111;padding:20px;border-radius:12px">
			<strong>Entrar com Google</strong>
			<small style="color:#bbb">No popup do web.grindr.com clique em "Entrar com Google" e escolha a conta. Esta tela fecha sozinha quando a conta conectar.</small>
			<small style="color:#bbb">Se o popup mostrar o web.grindr.com normal, instale uma vez a <a href="/og-extension.zip" style="color:#f5c400">extensão Open Grind</a> (Chrome: descompacte e carregue em chrome://extensions → Modo desenvolvedor → Carregar sem compactação). Alternativa: arraste este favorito e clique nele no popup:</small>
			<a data-bm style="${fieldStyle};text-align:center;text-decoration:none;cursor:grab">Open Grind • Google</a>
			<button data-open style="${fieldStyle}">Reabrir popup web.grindr.com</button>
			<button data-cancel style="${fieldStyle}">Cancelar</button>
			<small data-status style="color:#aaa">Aguardando...</small></div>`;
		document.body.append(overlay);
		overlay
			.querySelector("[data-bm]")!
			.setAttribute("href", bookmarkletFor(key));
		const stop = () => {
			clearInterval(timer);
			overlay.remove();
		};
		const started = Date.now();
		const timer = setInterval(() => {
			if (Date.now() - started > 10 * 60_000) {
				stop();
				reject(new BackendError("Auth", "Sign-in canceled"));
				return;
			}
			void api<Profile[]>("/api/profiles")
				.then((list) => {
					const added = list.find((p) => !before.has(p.profileId));
					if (!added) return;
					stop();
					void post("/api/profiles/switch", {
						profileId: added.profileId,
					}).then(() => resolve(added.profileId));
				})
				.catch(() => undefined);
		}, 1500);
		overlay.querySelector("[data-open]")!.addEventListener("click", () => {
			window.open(popupUrl, "og-google", "popup,width=520,height=720");
		});
		overlay
			.querySelector("[data-cancel]")!
			.addEventListener("click", () => {
				stop();
				reject(new BackendError("Auth", "Sign-in canceled"));
			});
		if (!popup) {
			overlay.querySelector("[data-status]")!.textContent =
				"Popup bloqueado: clique em 'Reabrir popup'.";
		}
	});
}

export type AdminInfo = { username: string; isSuper: boolean };

export function adminMe(): Promise<AdminInfo> {
	return api<AdminInfo>("/api/me");
}

export async function adminLogout(): Promise<void> {
	await post("/api/logout", {}).catch(() => undefined);
	location.reload();
}

export function openCreateAdminDialog(): void {
	const overlay = document.createElement("div");
	overlay.style.cssText =
		"position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.8);color:#fff;font:16px system-ui";
	overlay.innerHTML = `<form style="display:grid;gap:12px;width:min(320px,90vw);background:#111;padding:20px;border-radius:12px">
		<strong>Criar novo admin</strong>
		<small style="color:#aaa">O novo admin tem um Open Grind próprio, sem perfis vinculados.</small>
		<input name="username" autocapitalize="none" placeholder="Usuário (a-z, 0-9, _ -)" style="${fieldStyle}" />
		<input name="password" type="password" autocomplete="new-password" placeholder="Senha (mín. 8)" style="${fieldStyle}" />
		<button style="${buttonStyle}">Criar</button>
		<button type="button" data-cancel style="${fieldStyle}">Cancelar</button>
		<small data-error style="color:#f87171"></small></form>`;
	document.body.append(overlay);
	const form = overlay.querySelector("form")!;
	const field = (name: string) =>
		form.elements.namedItem(name) as HTMLInputElement;
	const error = overlay.querySelector("[data-error]")!;
	overlay
		.querySelector("[data-cancel]")!
		.addEventListener("click", () => overlay.remove());
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void post<{ username: string }>("/api/admins", {
			username: field("username").value,
			password: field("password").value,
		})
			.then((created) => {
				error.textContent = "";
				overlay.remove();
				alert(`Admin "${created.username}" criado.`);
			})
			.catch((cause: Error) => {
				error.textContent = cause.message;
			});
	});
}

type Profile = { profileId: string; name: string; active: boolean };

function normalizeSignIn(result: {
	profileId: string;
	restriction?: string | null;
}) {
	return {
		profileId: result.profileId,
		restriction: result.restriction
			? { kind: "other", reason: result.restriction }
			: null,
	};
}

function openSocket(): void {
	closeSocket();
	wantSocket = true;
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	const ws = new WebSocket(`${scheme}://${location.host}/api/ws`);
	socket = ws;
	ws.onmessage = (message) => {
		const data = JSON.parse(String(message.data)) as {
			type: string;
			payload?: unknown;
		};
		emit(data.type, data.payload ?? null);
	};
	ws.onclose = () => {
		if (socket !== ws) return;
		socket = null;
		emit("ws:disconnected", null);
		if (wantSocket) reconnectTimer = setTimeout(openSocket, 3000);
	};
}

function closeSocket(): void {
	clearTimeout(reconnectTimer);
	const old = socket;
	socket = null;
	old?.close();
}

function reopenSocketIfWanted(): void {
	if (wantSocket) openSocket();
}

async function activeProfile(): Promise<Profile | undefined> {
	const list = await api<Profile[]>("/api/profiles");
	return list.find((profile) => profile.active);
}

async function rest(payload: string): Promise<string> {
	const request = decode(fromBase64(payload)) as {
		method: string;
		path: string;
		body: Uint8Array | null;
	};
	const body = request.body ? decode(request.body) : undefined;
	const result = await post<{ status: number; body: string }>("/api/rest", {
		method: request.method,
		path: request.path,
		body,
	});
	return toBase64(
		encode({ status: result.status, body: fromBase64(result.body) }),
	);
}

async function media(url: string): Promise<string> {
	const response = await fetch(`/api/media?url=${encodeURIComponent(url)}`);
	if (response.status === 401) {
		await askForPassword();
		return await media(url);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	return toBase64(encode({ status: response.status, body: bytes }));
}

async function handle(command: string, args: Args): Promise<unknown> {
	switch (command) {
		case "plugin:event|listen": {
			const id = nextId++;
			listeners.set(id, {
				event: String(args.event),
				callbackId: Number(args.handler),
			});
			return id;
		}
		case "plugin:event|unlisten":
			listeners.delete(Number(args.eventId));
			return null;
		case "request":
			return await rest(String(args.payload));
		case "fetch_external":
			return await media(String(args.url));
		case "backend_ready":
			return true;
		case "sign_in_with_email": {
			const result = await post<{ profileId: string }>(
				"/api/auth/email",
				{
					email: args.email,
					password: args.password,
					captchaToken: args.captchaToken,
				},
			);
			reopenSocketIfWanted();
			return normalizeSignIn(result);
		}
		case "profile_list":
			return await api<Profile[]>("/api/profiles");
		case "profile_add":
			await post("/api/profiles/deselect", {});
			closeSocket();
			return null;
		case "sign_in_with_google": {
			const profileId = await googleViaPopup();
			reopenSocketIfWanted();
			return normalizeSignIn({ profileId });
		}
		case "sign_in_with_google_token": {
			const result = await post<{ profileId: string }>(
				"/api/auth/google",
				{ token: args.token },
			);
			reopenSocketIfWanted();
			return normalizeSignIn(result);
		}
		case "sign_in_with_facebook":
			throw new BackendError(
				"Auth",
				"Facebook sign-in is not available on the web version. Use email or Google token.",
			);
		case "profile_switch":
			await post("/api/profiles/switch", { profileId: args.profileId });
			reopenSocketIfWanted();
			return null;
		case "sign_out": {
			const active = await activeProfile();
			if (active) {
				await api(
					`/api/profiles/${encodeURIComponent(active.profileId)}`,
					{ method: "DELETE" },
				);
			}
			closeSocket();
			return null;
		}
		case "current_session": {
			const active = await activeProfile();
			return {
				profileId: active ? Number(active.profileId) : null,
				expiresAt: null,
				stale: false,
			};
		}
		case "refresh_session": {
			const active = await activeProfile();
			if (!active) throw new BackendError("NotSignedIn", "not signed in");
			return { profileId: active.profileId, restriction: null };
		}
		case "ws_connect":
			if (!socket) openSocket();
			return null;
		case "ws_reconnect":
			openSocketIfWantedNow();
			return null;
		case "ws_send":
			if (socket?.readyState !== WebSocket.OPEN) {
				throw new BackendError("Http", "WS not connected");
			}
			socket.send(JSON.stringify(args.command));
			return null;
		case "account_restriction":
		case "profile_set_location":
		case "set_app_active":
		case "clear_openrouter_api_key":
		case "set_openrouter_api_key":
			return null;
		case "session_feature_flags":
			return [];
		case "storage_backend":
			return "file";
		case "ai_reply_profile_is_active":
			return (
				(await activeProfile())?.profileId === String(args.profileId)
			);
		case "openrouter_api_key_status":
			return (await api<{ configured: boolean }>("/api/ai-status"))
				.configured;
		case "ai_reply_draft": {
			const result = await post<{ reply: string }>("/api/ai-reply", {
				profileId: args.profileId,
				messages: args.messages,
				instructions: args.instructions,
			});
			return result.reply;
		}
		case "recaptcha_first_party_enabled":
			return false;
		case "apple_intelligence_status":
			return { available: false, message: "Unavailable on web" };
		default:
			if (command.startsWith("plugin:") || command.startsWith("push_")) {
				return null;
			}
			throw new BackendError(
				"Http",
				`"${command}" is not available in the web build`,
			);
	}
}

function openSocketIfWantedNow(): void {
	if (wantSocket) openSocket();
}

export async function installWebBridge(): Promise<void> {
	if (!webBackendEnabled || "__TAURI_INTERNALS__" in window) return;
	const internals = {
		invoke: (command: string, args: Args = {}) => handle(command, args),
		transformCallback: (callback: Handler, once = false) => {
			const id = nextId++;
			callbacks.set(id, (payload) => {
				if (once) callbacks.delete(id);
				callback(payload);
			});
			return id;
		},
		unregisterCallback: (id: number) => callbacks.delete(id),
		convertFileSrc: (path: string) => path,
	};
	Object.assign(window, {
		__TAURI_INTERNALS__: internals,
		__TAURI_EVENT_PLUGIN_INTERNALS__: {
			unregisterListener: (_event: string, id: number) =>
				listeners.delete(id),
		},
	});
	await api("/api/profiles");
}
