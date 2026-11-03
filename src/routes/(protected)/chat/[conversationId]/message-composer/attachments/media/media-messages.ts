import {
	type MediaFileInspection,
	type MediaPreview,
} from "$lib/platform/media-file";
import type { MessageDraft } from "$lib/model/messaging/messages";
export { mediaMessageDraft } from "$lib/chat/media-message-draft";

const REPLAYABLE_MAX_VIEWS = 2;

export function sendNowDraft({
	inspection,
	preview,
	upload,
}: {
	inspection: MediaFileInspection & { kind: "photo" | "video" };
	preview: MediaPreview | null;
	upload: () => Promise<number>;
}): MessageDraft {
	if (inspection.kind === "video") {
		return {
			outbound: async () => ({
				type: "Video",
				body: {
					mediaId: await upload(),
					looping: false,
					maxViews: REPLAYABLE_MAX_VIEWS,
				},
			}),
			optimistic: {
				type: "Video",
				body: {
					mediaId: 0,
					url: "",
					contentType: "video/mp4",
					length: inspection.durationMs ?? 0,
					maxViews: REPLAYABLE_MAX_VIEWS,
					viewsRemaining: REPLAYABLE_MAX_VIEWS,
					looping: false,
				},
			},
		};
	}
	return {
		outbound: async () => ({
			type: "Image",
			body: { mediaId: await upload() },
		}),
		optimistic: {
			type: "Image",
			body: {
				mediaId: 0,
				url: preview?.dataUrl ?? "",
				width: preview?.width ?? null,
				height: preview?.height ?? null,
				imageHash: "",
				takenOnGrindr: false,
				createdAt: Date.now(),
			},
		},
	};
}
