(() => {
	const m = /^#og=([^@]+)@(https:\/\/[^/]+)$/.exec(location.hash);
	if (!m) return;
	const [, key, origin] = m;
	const CLIENT_ID =
		"1036042917246-htcnf9mm3qnis86l47ngp0a9ncqsll7j.apps.googleusercontent.com";
	history.replaceState(null, "", location.pathname + location.search);
	document.documentElement.innerHTML = "";
	const box = document.createElement("div");
	box.style.cssText =
		"position:fixed;inset:0;display:flex;flex-direction:column;gap:14px;align-items:center;justify-content:center;background:#0a0a0a;color:#fff;font:16px system-ui";
	const title = document.createElement("strong");
	title.textContent = "Open Grind — Entrar com Google";
	const button = document.createElement("button");
	button.textContent = "Entrar com Google";
	button.style.cssText =
		"padding:14px 28px;border-radius:10px;border:0;background:#f5c400;color:#000;font:600 18px system-ui;cursor:pointer";
	const status = document.createElement("small");
	box.append(title, button, status);
	document.body.append(box);
	const s = document.createElement("script");
	s.src = "https://accounts.google.com/gsi/client";
	document.head.append(s);
	button.onclick = () => {
		status.textContent = "";
		google.accounts.oauth2
			.initTokenClient({
				client_id: CLIENT_ID,
				scope: "email profile",
				callback: async (r) => {
					if (!r.access_token) {
						status.textContent = "Google não retornou token.";
						return;
					}
					try {
						const x = await fetch(origin + "/api/google-handoff", {
							method: "POST",
							headers: { "content-type": "text/plain" },
							body: JSON.stringify({ key, token: r.access_token }),
						});
						const j = await x.json().catch(() => ({}));
						if (x.ok) window.close();
						else status.textContent = "Falha: " + (j.error || x.status);
					} catch (e) {
						status.textContent = "Erro de rede: " + e;
					}
				},
				error_callback: (e) => {
					status.textContent = "Google: " + (e && e.type);
				},
			})
			.requestAccessToken({ prompt: "select_account" });
	};
})();
