// SPDX-License-Identifier: AGPL-3.0-only

import { RookError } from "./error-format.js";
import { canonicalRepoSource, normalizeRepoIdentity } from "./git.js";
import { withTimeout } from "./network.js";

const REPO_COLLECTION = "sh.tangled.repo";
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

function repoCreateError(message, code = "repo-create-rejected") {
	return new RookError(message, { code });
}

function repoRecordError(message, code = "repo-record-rejected") {
	return new RookError(message, { code });
}

function validateHost(host) {
	if (!nonempty(host) || host.trim() !== host) throw new RookError("knot host is invalid");
	let url;
	try {
		url = new URL(`https://${host}`);
	} catch {
		throw new RookError("knot host is invalid");
	}
	if (
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== "" ||
		url.hostname === ""
	) {
		throw new RookError("knot host is invalid");
	}
	return url.host.toLowerCase();
}

async function responseJson(response) {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

function recordEndpoint(nsid, params) {
	const query = new URLSearchParams(params);
	return `/xrpc/${nsid}?${query}`;
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

function validKnotName(value) {
	return (
		nonempty(value) &&
		value.length <= 100 &&
		/^[A-Za-z0-9._-]+$/.test(value) &&
		!value.startsWith(".") &&
		!value.endsWith(".") &&
		!value.includes("..") &&
		value.toLowerCase() !== "self"
	);
}

export function validateKnotRepoName(name) {
	if (!validKnotName(name) || !validRecordKey(name)) {
		throw new RookError("upstream repository name is not valid for Tangled", {
			code: "upstream-url-invalid",
		});
	}
	return name;
}

export function deriveKnotRepoName(normalizedIdentity) {
	if (typeof normalizedIdentity !== "string") {
		throw new RookError("upstream repository name cannot be derived", {
			code: "upstream-url-invalid",
		});
	}
	const name = normalizedIdentity.slice(normalizedIdentity.lastIndexOf("/") + 1);
	return validateKnotRepoName(name);
}

function validateRecordRequest(repo, rkey) {
	if (!validDid(repo) || !validRecordKey(rkey)) {
		throw repoRecordError("repository record request is invalid");
	}
}

function validateRecordForCreate(record, rkey) {
	const keys = ["$type", "createdAt", "knot", "name", "repoDid", "source"];
	if (!plainObject(record) || Object.keys(record).sort().join("\n") !== keys.join("\n")) {
		throw repoRecordError("repository record is invalid");
	}
	let canonicalCreatedAt;
	try {
		canonicalCreatedAt = new Date(record.createdAt).toISOString();
	} catch {
		throw repoRecordError("repository record is invalid");
	}
	let validKnot = false;
	let validSource = false;
	try {
		validKnot = validateHost(record.knot) === record.knot;
		validSource = canonicalRepoSource(record.source) === record.source;
	} catch {
		throw repoRecordError("repository record is invalid");
	}
	if (
		record.$type !== REPO_COLLECTION ||
		!validKnot ||
		canonicalCreatedAt !== record.createdAt ||
		!validDid(record.repoDid) ||
		!validSource ||
		!validKnotName(record.name) ||
		record.name !== rkey
	) {
		throw repoRecordError("repository record is invalid");
	}
}

export function deriveRepoUrl(host, repoDid) {
	if (!validDid(repoDid)) throw new RookError("repository DID is invalid");
	return `https://${validateHost(host)}/${repoDid}`;
}

export async function createKnotRepo(target, input, dependencies = {}) {
	if (
		!nonempty(input?.token) ||
		!validKnotName(input?.rkey) ||
		input.rkey !== input.name ||
		!nonempty(input?.defaultBranch) ||
		!nonempty(input?.source)
	) {
		throw repoCreateError("knot repository request is invalid");
	}
	try {
		if (canonicalRepoSource(input.source) !== input.source) {
			throw repoCreateError("knot repository request is invalid");
		}
	} catch {
		throw repoCreateError("knot repository request is invalid");
	}
	let url;
	try {
		url = new URL("/xrpc/sh.tangled.repo.create", target.origin);
	} catch {
		throw repoCreateError("knot repository target is invalid");
	}
	if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
		throw repoCreateError("knot repository target is invalid");
	}
	let response;
	try {
		response = await (dependencies.fetch ?? globalThis.fetch)(
			url,
			withTimeout(
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${input.token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						rkey: input.rkey,
						name: input.name,
						defaultBranch: input.defaultBranch,
						source: input.source,
					}),
				},
				dependencies,
			),
		);
	} catch {
		throw repoCreateError("knot repository request failed");
	}
	if (response.status === 409) {
		throw repoCreateError("knot repository already conflicts", "repo-create-conflict");
	}
	if (response.status !== 200) {
		throw repoCreateError("knot repository request was rejected");
	}
	const body = await responseJson(response);
	if (!validDid(body?.repoDid)) {
		throw repoCreateError("knot repository response is invalid", "repo-create-invalid-response");
	}
	// A 200 response does not reveal whether the knot created or adopted the repository.
	return { repoDid: body.repoDid };
}

export async function readRepoRecord(session, { repo, rkey }, dependencies = {}) {
	validateRecordRequest(repo, rkey);
	let response;
	try {
		response = await session.fetchHandler(
			recordEndpoint("com.atproto.repo.getRecord", {
				repo,
				collection: REPO_COLLECTION,
				rkey,
			}),
			withTimeout({}, dependencies),
		);
	} catch {
		throw repoRecordError("repository record could not be read");
	}
	const body = await responseJson(response);
	if (response.status === 400 && body?.error === "RecordNotFound") return undefined;
	if (response.status !== 200) throw repoRecordError("repository record read was rejected");
	if (!plainObject(body) || !plainObject(body.value)) {
		throw repoRecordError("repository record response is invalid", "repo-record-invalid-response");
	}
	return body.value;
}

function expectedRecordUri(repo, rkey) {
	return `at://${repo}/${REPO_COLLECTION}/${rkey}`;
}

export async function createRepoRecord(session, { repo, rkey, record }, dependencies = {}) {
	validateRecordRequest(repo, rkey);
	validateRecordForCreate(record, rkey);
	let response;
	try {
		response = await session.fetchHandler(
			"/xrpc/com.atproto.repo.createRecord",
			withTimeout(
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ repo, collection: REPO_COLLECTION, rkey, record }),
				},
				dependencies,
			),
		);
	} catch {
		throw repoRecordError("repository record could not be created");
	}
	const body = await responseJson(response);
	if (response.status === 400 && body?.error === "RecordAlreadyExists") {
		throw repoRecordError("repository record already exists", "repo-record-conflict");
	}
	if (response.status !== 200) throw repoRecordError("repository record create was rejected");
	if (body?.uri !== expectedRecordUri(repo, rkey)) {
		throw repoRecordError("repository record response is invalid", "repo-record-invalid-response");
	}
	return { uri: body.uri };
}

export function repoRecordMatches(record, expected) {
	if (
		!["$type", "knot", "repoDid", "name"].every((field) => record?.[field] === expected?.[field])
	) {
		return false;
	}
	try {
		return normalizeRepoIdentity(record.source) === normalizeRepoIdentity(expected.source);
	} catch {
		return false;
	}
}

export async function receivePackAdvertisement(repoUrl, { token }, dependencies = {}) {
	let url;
	try {
		url = new URL(repoUrl);
		if (
			url.protocol !== "https:" ||
			url.username !== "" ||
			url.password !== "" ||
			url.search !== "" ||
			url.hash !== "" ||
			url.pathname === "/"
		) {
			throw new Error("invalid URL");
		}
		url.pathname = `${url.pathname.replace(/\/$/, "")}/info/refs`;
		url.searchParams.set("service", "git-receive-pack");
	} catch {
		throw new RookError("receive-pack repository URL is invalid", {
			code: "receive-pack-rejected",
		});
	}
	if (!nonempty(token)) {
		throw new RookError("receive-pack authorization is missing", {
			code: "receive-pack-rejected",
		});
	}
	let response;
	try {
		response = await (dependencies.fetch ?? globalThis.fetch)(
			url,
			withTimeout({ headers: { Authorization: `Bearer ${token}` } }, dependencies),
		);
	} catch {
		throw new RookError("receive-pack advertisement is unavailable", {
			code: "receive-pack-unavailable",
		});
	}
	if (response.status >= 500) {
		throw new RookError("receive-pack advertisement is unavailable", {
			code: "receive-pack-unavailable",
		});
	}
	const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
	if (response.status !== 200 || mediaType !== "application/x-git-receive-pack-advertisement") {
		throw new RookError("receive-pack advertisement was rejected", {
			code: "receive-pack-rejected",
		});
	}
	return { ok: true };
}
