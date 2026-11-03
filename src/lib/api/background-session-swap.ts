// Tracks the windows in which the backend session temporarily belongs to a
// different saved profile (background unread scans). Requests that fail with
// NotSignedIn inside such a window are expected: the session is someone
// else's for a few seconds, not gone. Sign-out plumbing must ignore them.
//
// Leaf module on purpose: the transport layer reads this flag, so it cannot
// import anything that (transitively) imports the transport layer.
let depth = 0;
let requestCount = 0;
let swapRequestFloor: number | null = null;

export function beginBackgroundSessionSwap(): () => void {
	depth += 1;
	swapRequestFloor ??= requestCount;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		depth = Math.max(0, depth - 1);
		if (depth === 0) swapRequestFloor = null;
	};
}

export function backgroundSessionSwapInFlight(): boolean {
	return depth > 0;
}

/** How long fenced work waits for a background session swap to settle. */
export const swapSettleWaitMs = 20_000;

/** Sequence number for a request, to order it against swap windows. */
export function nextRequestSequence(): number {
	requestCount += 1;
	return requestCount;
}

/**
 * Whether the request with the given sequence number started before the
 * in-flight swap began. Requests issued by the scan itself start after and
 * must fail fast instead of waiting on their own swap.
 */
export function requestPredatesSwap(sequence: number): boolean {
	return swapRequestFloor !== null && sequence <= swapRequestFloor;
}

const settlePollMs = 50;

/** Resolves true once no swap is running, false after timeoutMs. */
export function awaitBackgroundSwapEnd(timeoutMs: number): Promise<boolean> {
	if (depth === 0) return Promise.resolve(true);
	return new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;
		const timer = setInterval(() => {
			if (depth === 0 || Date.now() >= deadline) {
				clearInterval(timer);
				resolve(depth === 0);
			}
		}, settlePollMs);
	});
}
