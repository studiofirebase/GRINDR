import type { Page } from "@playwright/test";

const DISPLAY = { width: 1080, height: 1920 };
const DENSITY_MEDIUM_DPI = 160;
const LARGE_DISPLAY_SIZE_DPI = 460;
const DEVICE_SCALE_FACTOR = LARGE_DISPLAY_SIZE_DPI / DENSITY_MEDIUM_DPI;

export const phoneDisplay = {
	viewport: {
		width: Math.ceil(DISPLAY.width / DEVICE_SCALE_FACTOR),
		height: Math.ceil(DISPLAY.height / DEVICE_SCALE_FACTOR),
	},
	deviceScaleFactor: DEVICE_SCALE_FACTOR,
};

export async function cropToDisplay({
	page,
	image,
}: {
	page: Page;
	image: Buffer;
}): Promise<Buffer> {
	const cropped = await page.evaluate(
		async ({ png, width, height }) => {
			const decodeOptions: ImageBitmapOptions = {
				colorSpaceConversion: "none",
				premultiplyAlpha: "none",
			};
			const source = await createImageBitmap(
				new Blob([Uint8Array.fromBase64(png)]),
				decodeOptions,
			);
			if (source.width < width || source.height < height) {
				throw new Error(
					`The ${source.width}x${source.height} capture is smaller than the ${width}x${height} display`,
				);
			}
			const canvas = new OffscreenCanvas(width, height);
			const renderer = canvas.getContext("bitmaprenderer");
			if (!renderer) throw new Error("No bitmap renderer to crop with");
			renderer.transferFromImageBitmap(
				await createImageBitmap(
					source,
					0,
					0,
					width,
					height,
					decodeOptions,
				),
			);
			const blob = await canvas.convertToBlob({
				type: "image/jpeg",
				quality: 0.9,
			});
			return new Uint8Array(await blob.arrayBuffer()).toBase64();
		},
		{ png: image.toString("base64"), ...DISPLAY },
	);
	return Buffer.from(cropped, "base64");
}
