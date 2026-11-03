import z from "zod";

import {
	awaitBackgroundSwapEnd,
	backgroundSessionSwapInFlight,
	swapSettleWaitMs,
} from "$lib/api/background-session-swap";
import { fetchRest } from "$lib/api/transport";
import { coarsenGeohash } from "$lib/model/geohash";

const placesResponseSchema = z.object({
	places: z.array(
		z.object({
			name: z.string(),
			address: z.string().nullable(),
			lat: z.number(),
			lon: z.number(),
			importance: z.number(),
		}),
	),
});

export async function updateLocation({ geohash }: { geohash: string }) {
	// The location endpoint applies to whoever the backend currently is:
	// never move another profile while a background scan owns the session.
	if (
		backgroundSessionSwapInFlight() &&
		!(await awaitBackgroundSwapEnd(swapSettleWaitMs))
	) {
		throw new Error(
			"The app is finishing a background sync; try changing location again.",
		);
	}
	return await fetchRest("/v4/location", {
		method: "PUT",
		body: { geohash: coarsenGeohash(geohash) },
	}).then((res) => res.assertOk());
}

export async function getPlaces({ query }: { query: string }) {
	const response = await fetchRest(
		"/v3/places/search?" +
			new URLSearchParams({ placeName: query }).toString(),
	).then((res) => res.jsonParsed(placesResponseSchema));
	return response;
}
