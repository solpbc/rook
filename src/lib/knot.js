// SPDX-License-Identifier: AGPL-3.0-only

import { RookError } from "./error-format.js";
import { rpcScopes } from "./oauth.js";

export function deriveKnotTarget(scope) {
	const entries = rpcScopes(scope);
	if (entries.length === 0) throw new RookError("served scope does not grant a knot RPC audience");
	const audiences = new Set(entries.map(({ aud }) => aud));
	if (audiences.size !== 1) throw new RookError("served RPC scopes do not share one knot audience");
	const aud = entries[0].aud;
	if (!aud.startsWith("did:web:")) throw new RookError("served knot audience is not a did:web DID");
	const encoded = aud.slice("did:web:".length).split(":");
	const host = decodeURIComponent(encoded.shift());
	if (!host || encoded.length > 0)
		throw new RookError("served knot audience is not a host-only did:web DID");
	return { aud, host, origin: `https://${host}`, subject: host, rpcScopes: entries };
}

export async function listKnotMembers(target, options = {}) {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const members = new Set();
	const cursors = new Set();
	let cursor;
	for (let page = 0; page < (options.maxPages ?? 1000); page += 1) {
		const url = new URL("/xrpc/sh.tangled.knot.listMembers", target.origin);
		url.searchParams.set("subject", target.subject);
		url.searchParams.set("limit", "1000");
		url.searchParams.set("order", "asc");
		if (cursor) url.searchParams.set("cursor", cursor);
		let response;
		try {
			response = await fetchImpl(url, {
				signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 10_000),
			});
		} catch {
			throw new RookError("could not verify membership");
		}
		if (!response.ok) throw new RookError("could not verify membership");
		const text = await response.text();
		if (text.length > (options.maxResponseBytes ?? 2_000_000)) {
			throw new RookError("could not verify membership");
		}
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			throw new RookError("could not verify membership");
		}
		if (!Array.isArray(body.items)) throw new RookError("could not verify membership");
		for (const item of body.items) {
			if (!item || typeof item.subject !== "string")
				throw new RookError("could not verify membership");
			members.add(item.subject);
		}
		if (body.cursor === undefined || body.cursor === null || body.cursor === "") return members;
		if (typeof body.cursor !== "string" || cursors.has(body.cursor)) {
			throw new RookError("could not verify membership");
		}
		cursors.add(body.cursor);
		cursor = body.cursor;
	}
	throw new RookError("could not verify membership");
}
