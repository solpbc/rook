// SPDX-License-Identifier: AGPL-3.0-only

import { publishCap } from "vit/cap.js";
import { RookError } from "./error-format.js";
import { listAllRecords } from "./records.js";

export const CAP_COLLECTION = "org.v-it.cap";

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;

function nonempty(value) {
	return typeof value === "string" && value.length > 0;
}

function validDid(value) {
	return nonempty(value) && DID.test(value);
}

function plainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validRecordKey(value) {
	return (
		nonempty(value) &&
		value.length <= 512 &&
		value !== "." &&
		value !== ".." &&
		/^[A-Za-z0-9_~.:-]+$/.test(value)
	);
}

function capError(message, code = "cap-rejected", options = {}) {
	return new RookError(message, { code, ...options });
}

function isSwapConflict(error) {
	return error?.error === "InvalidSwap" || /InvalidSwap/.test(error?.message ?? "");
}

export function expectedCapUri(repo, rkey) {
	return `at://${repo}/${CAP_COLLECTION}/${rkey}`;
}

// Derive the vit beacon from the already-canonical upstream URL
// (https://host/org/repo(.git)). A single-repo path renders host//repo.
export function deriveBeacon(upstreamUrl) {
	let url;
	try {
		url = new URL(upstreamUrl);
	} catch {
		throw capError("upstream URL is invalid for a beacon", "beacon-invalid");
	}
	if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
		throw capError("upstream URL is invalid for a beacon", "beacon-invalid");
	}
	const host = url.host.toLowerCase();
	const segments = url.pathname
		.replace(/^\/+|\/+$/g, "")
		.replace(/\.git$/, "")
		.split("/")
		.filter(Boolean)
		.map((segment) => segment.toLowerCase());
	if (segments.length === 1) return `vit:${host}//${segments[0]}`;
	if (segments.length === 2) return `vit:${host}/${segments[0]}/${segments[1]}`;
	throw capError("upstream URL is invalid for a beacon", "beacon-invalid");
}

export async function listCapRecords(agent, repo, dependencies = {}) {
	return listAllRecords(agent, repo, CAP_COLLECTION, { ...dependencies, listCodePrefix: "cap" });
}

// Identity match: a cap is the same self-pull cap when it points at the same
// rendered pull URL and beacon (and, for a request, replies to the same parent).
export function capMatches(record, { renderedPullUrl, beacon, requestParentUri }) {
	if (!plainObject(record)) return false;
	if (record.embed?.external?.uri !== renderedPullUrl) return false;
	if (record.beacon !== beacon) return false;
	if (requestParentUri) return record.reply?.parent?.uri === requestParentUri;
	return true;
}

// Content match: identical overridable content, so a re-run can adopt without a
// redundant write. Identity (embed uri + beacon) is already confirmed separately.
export function capUnchanged(record, desired) {
	if (!plainObject(record)) return false;
	const external = record.embed?.external;
	if (
		!external ||
		external.uri !== desired.embedExternal.uri ||
		external.title !== desired.embedExternal.title ||
		external.description !== desired.embedExternal.description
	) {
		return false;
	}
	if (record.title !== desired.title) return false;
	if (record.description !== desired.description) return false;
	if ((record.text ?? "") !== (desired.text ?? "")) return false;
	if ((record.kind ?? undefined) !== (desired.kind ?? undefined)) return false;
	if (desired.reply) {
		if (
			record.reply?.parent?.uri !== desired.reply.parent.uri ||
			record.reply?.parent?.cid !== desired.reply.parent.cid ||
			record.reply?.root?.uri !== desired.reply.root.uri ||
			record.reply?.root?.cid !== desired.reply.root.cid
		) {
			return false;
		}
	} else if (record.reply !== undefined) {
		return false;
	}
	return true;
}

function parseCapUri(uri) {
	if (!nonempty(uri) || !uri.startsWith("at://")) return undefined;
	const parts = uri.slice("at://".length).split("/");
	if (
		parts.length !== 3 ||
		!validDid(parts[0]) ||
		parts[1] !== CAP_COLLECTION ||
		!validRecordKey(parts[2])
	) {
		return undefined;
	}
	return { repo: parts[0], rkey: parts[2] };
}

// Strong references for a request reply, resolved from the request's authoritative
// PDS. Reply parent is the request's current uri/cid; root is its own root when it
// already belongs to a thread, else the request itself.
export async function resolveRequestCap(agent, requestUri, _dependencies = {}) {
	const parsed = parseCapUri(requestUri);
	if (!parsed) {
		throw capError("request cap URI is invalid", "request-cap-unresolved", {
			remediation: "pass a valid org.v-it.cap at:// URI to --request",
		});
	}
	let response;
	try {
		response = await agent.com.atproto.repo.getRecord({
			repo: parsed.repo,
			collection: CAP_COLLECTION,
			rkey: parsed.rkey,
		});
	} catch (cause) {
		throw capError("request cap could not be resolved", "request-cap-unresolved", {
			remediation: "verify the --request cap exists and is reachable",
			cause,
		});
	}
	const data = response?.data;
	if (
		!plainObject(data) ||
		!plainObject(data.value) ||
		data.uri !== requestUri ||
		!nonempty(data.cid)
	) {
		throw capError("request cap could not be resolved", "request-cap-unresolved");
	}
	if (data.value.$type !== CAP_COLLECTION) {
		throw capError("request target is not a cap", "request-cap-unresolved");
	}
	const parent = { uri: data.uri, cid: data.cid };
	const existingRoot = data.value.reply?.root;
	const root =
		plainObject(existingRoot) && nonempty(existingRoot.uri) && nonempty(existingRoot.cid)
			? { uri: existingRoot.uri, cid: existingRoot.cid }
			: parent;
	return { parent, root };
}

function summarize(result, repo, createdAt, outcome) {
	if (
		!plainObject(result) ||
		result.uri !== expectedCapUri(repo, result.rkey) ||
		!nonempty(result.cid) ||
		!nonempty(result.ref)
	) {
		throw capError("cap publish returned an invalid response", "cap-invalid-response");
	}
	return {
		uri: result.uri,
		cid: result.cid,
		capRef: result.ref,
		rkey: result.rkey,
		createdAt,
		outcome,
	};
}

// Create or refresh the single canonical cap through vit's publishCap. The cap
// schema and swap semantics live entirely in vit/cap.js; this only supplies the
// adopt/refresh inputs and preserves rkey/ref/createdAt on refresh.
export async function publishOrRefreshCap(agent, input, dependencies = {}) {
	const publish = dependencies.publishCap ?? publishCap;
	const base = {
		repo: input.repo,
		text: input.text ?? "",
		title: input.title,
		description: input.description,
		beacon: input.beacon,
		embed: { external: input.embedExternal },
		...(input.reply ? { reply: input.reply } : {}),
		...(input.kind ? { kind: input.kind } : {}),
	};
	if (input.existing) {
		let result;
		try {
			result = await publish(agent, {
				...base,
				rkey: input.existing.rkey,
				swapCid: input.existing.cid,
				ref: input.existing.capRef,
				createdAt: input.existing.createdAt,
			});
		} catch (error) {
			if (isSwapConflict(error)) {
				throw capError("cap changed since it was read", "cap-cas-conflict", {
					remediation: "run rook ship again",
					cause: error,
				});
			}
			throw error;
		}
		return summarize(result, input.repo, input.existing.createdAt, "refreshed");
	}
	const result = await publish(agent, {
		...base,
		...(input.ref ? { ref: input.ref } : {}),
		createdAt: input.createdAt,
	});
	return summarize(result, input.repo, input.createdAt, "created");
}
