// SPDX-License-Identifier: AGPL-3.0-only

import { RookError } from "./error-format.js";
import { withTimeout } from "./network.js";

const PLC_DID = /^did:plc:[A-Za-z0-9._:%-]+$/;

function plainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function responseJson(response) {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

export async function resolvePdsEndpoint(did, dependencies = {}) {
	try {
		if (typeof did !== "string" || !PLC_DID.test(did)) throw new Error("invalid DID");
		const fetchImpl = dependencies.fetch ?? globalThis.fetch;
		const response = await fetchImpl(
			`https://plc.directory/${encodeURIComponent(did)}`,
			withTimeout({}, dependencies),
		);
		if (!response.ok) throw new Error("DID resolution rejected");
		const document = await responseJson(response);
		if (!plainObject(document) || !Array.isArray(document.service)) {
			throw new Error("invalid DID document");
		}
		const service = document.service.find(
			(entry) =>
				plainObject(entry) &&
				(entry.id === "#atproto_pds" || entry.id === `${did}#atproto_pds`) &&
				entry.type === "AtprotoPersonalDataServer" &&
				typeof entry.serviceEndpoint === "string" &&
				entry.serviceEndpoint.length > 0,
		);
		if (!service) throw new Error("PDS service missing");
		const endpoint = new URL(service.serviceEndpoint);
		if (
			endpoint.protocol !== "https:" ||
			endpoint.username !== "" ||
			endpoint.password !== "" ||
			endpoint.host === ""
		) {
			throw new Error("unsafe PDS endpoint");
		}
		return endpoint.origin;
	} catch {
		throw new RookError("PDS endpoint could not be resolved", { code: "pds-unresolved" });
	}
}
