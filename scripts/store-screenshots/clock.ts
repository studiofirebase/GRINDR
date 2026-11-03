import type { Page } from "@playwright/test";

const CAPTURED_AT = Date.parse("2026-07-21T13:12:00Z");
const RELEASE_EVENT = "store-screenshots:release-clock";

export async function freezeClockOnEveryLoad(page: Page): Promise<void> {
	await page.addInitScript(
		({ capturedAt, releaseEvent }) => {
			const SystemDate = Date;
			let offset: number | null = null;
			const now = () =>
				offset === null ? capturedAt : SystemDate.now() + offset;
			addEventListener(
				releaseEvent,
				() => {
					offset = capturedAt - SystemDate.now();
				},
				{ once: true },
			);
			class CapturedDate extends SystemDate {
				constructor(
					...args: [] | ConstructorParameters<DateConstructor>
				) {
					if (args.length === 0) super(now());
					else super(...args);
				}

				static override now(): number {
					return now();
				}
			}
			globalThis.Date = CapturedDate as DateConstructor;
		},
		{ capturedAt: CAPTURED_AT, releaseEvent: RELEASE_EVENT },
	);
}

export async function releaseClock(page: Page): Promise<void> {
	await page.evaluate(
		(releaseEvent) => dispatchEvent(new Event(releaseEvent)),
		RELEASE_EVENT,
	);
}
