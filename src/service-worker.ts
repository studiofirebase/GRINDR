/// <reference lib="webworker" />

import { build, files, version } from "$service-worker";

const worker = self as unknown as ServiceWorkerGlobalScope;
const cacheName = `open-grind-static-${version}`;
const cacheablePaths = new Set(
	[...build, ...files].map(
		(path) => new URL(path, worker.location.origin).pathname,
	),
);
const appUrl = new URL("/", worker.location.origin).href;

worker.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(cacheName);
			await cache.addAll([...build, ...files, appUrl]);
			await worker.skipWaiting();
		})(),
	);
});

worker.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(
				keys
					.filter(
						(key) =>
							key.startsWith("open-grind-static-") &&
							key !== cacheName,
					)
					.map((key) => caches.delete(key)),
			);
			await worker.clients.claim();
		})(),
	);
});

worker.addEventListener("fetch", (event) => {
	const { request } = event;
	if (request.method !== "GET") return;

	const url = new URL(request.url);
	if (url.origin !== worker.location.origin) return;

	if (request.mode === "navigate") {
		event.respondWith(
			(async () => {
				try {
					return await fetch(request);
				} catch (error) {
					const cached = await caches.match(appUrl);
					if (cached) return cached;
					throw error;
				}
			})(),
		);
		return;
	}

	if (!cacheablePaths.has(url.pathname)) return;
	event.respondWith(
		(async () => {
			const cached = await caches.match(request);
			if (cached) return cached;

			const response = await fetch(request);
			if (response.ok && response.type === "basic") {
				const cache = await caches.open(cacheName);
				await cache.put(request, response.clone());
			}
			return response;
		})(),
	);
});
