// SPDX-License-Identifier: AGPL-3.0-only

import { RookError } from "./error-format.js";

async function checkedFetch(fetchImpl, url, options, label) {
	let response;
	try {
		response = await fetchImpl(url, options);
	} catch {
		throw new RookError(`could not fetch ${label}`);
	}
	if (!response.ok) throw new RookError(`${label} returned HTTP ${response.status}`);
	return response;
}

export async function fetchWelcome(serviceOrigin, fetchImpl = globalThis.fetch) {
	const response = await checkedFetch(
		fetchImpl,
		new URL("/.well-known/welcome.md", serviceOrigin),
		undefined,
		"welcome document",
	);
	const text = await response.text();
	if (!text.includes("GET /tos") || !text.includes("POST /api/signup")) {
		throw new RookError("welcome document does not advertise the required enrollment endpoints");
	}
	return { tosPath: "/tos", signupPath: "/api/signup", text };
}

export async function fetchTos(serviceOrigin, fetchImpl = globalThis.fetch) {
	const response = await checkedFetch(
		fetchImpl,
		new URL("/tos", serviceOrigin),
		undefined,
		"terms of service",
	);
	return response.text();
}

export async function verifyHandleDid(identity, fetchImpl = globalThis.fetch) {
	let plcResponse;
	try {
		plcResponse = await fetchImpl(`https://plc.directory/${encodeURIComponent(identity.did)}`);
	} catch {
		throw new RookError("could not resolve the stored DID");
	}
	if (!plcResponse.ok) throw new RookError(`DID resolution returned HTTP ${plcResponse.status}`);
	let document;
	try {
		document = await plcResponse.json();
	} catch {
		throw new RookError("DID resolution returned malformed JSON");
	}
	if (
		!Array.isArray(document.alsoKnownAs) ||
		!document.alsoKnownAs.includes(`at://${identity.handle}`)
	) {
		return false;
	}
	let handleResponse;
	try {
		handleResponse = await fetchImpl(`https://${identity.handle}/.well-known/atproto-did`);
	} catch {
		throw new RookError("could not resolve the stored handle");
	}
	if (!handleResponse.ok)
		throw new RookError(`handle resolution returned HTTP ${handleResponse.status}`);
	return (await handleResponse.text()).trim() === identity.did;
}
