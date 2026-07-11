// SPDX-License-Identifier: AGPL-3.0-only

import { RookError } from "./error-format.js";
import { timeoutSignal } from "./network.js";

function rejected(message) {
	return new RookError(message, { code: "service-auth-rejected" });
}

function unavailable() {
	return new RookError("could not mint service authorization", {
		code: "service-auth-unavailable",
	});
}

export async function mintServiceAuth(
	session,
	{ serviceOrigin, aud, lxm, expSeconds = 60 },
	dependencies = {},
) {
	const now = Math.floor((dependencies.clock?.() ?? Date.now()) / 1000);
	let url;
	try {
		url = new URL("/xrpc/com.atproto.server.getServiceAuth", serviceOrigin);
		url.searchParams.set("aud", aud);
		url.searchParams.set("lxm", lxm);
		url.searchParams.set("exp", String(now + expSeconds));
	} catch {
		throw unavailable();
	}

	let response;
	try {
		response = await session.fetchHandler(url.toString(), {
			signal: timeoutSignal(dependencies),
		});
	} catch {
		throw unavailable();
	}

	let body;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	if (response.status === 200) {
		if (typeof body?.token === "string" && body.token.length > 0) return body.token;
		throw unavailable();
	}
	if (response.status === 401) throw rejected("OAuth session was rejected");
	if (response.status === 403 && body?.error === "InsufficientScope") {
		throw rejected("service authorization scope is insufficient");
	}
	throw unavailable();
}
