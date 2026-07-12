// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { RookError } from "./error-format.js";
import { scopeSet } from "./oauth.js";

export const PROFILE_COLLECTION = "cloud.thermals.actor.profile";
export const PROFILE_RKEY = "self";
export const MAX_TAGS = 8;

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;

const IMAGE_MIME = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

function nonempty(value) {
	return typeof value === "string" && value.length > 0;
}

function validDid(value) {
	return nonempty(value) && DID.test(value);
}

function plainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function profileError(message, code = "profile-rejected", options = {}) {
	return new RookError(message, { code, ...options });
}

// The absent self record is a state, not a failure. A live PDS raises this as a
// RecordNotFoundError (HTTP 404, error "RecordNotFound"); the authoritative
// signal is the XRPC error code, so match it independent of the status enum.
function isRecordNotFound(error) {
	return (
		error?.error === "RecordNotFound" ||
		/RecordNotFound|Record not found/i.test(error?.message ?? "")
	);
}

function isSwapConflict(error) {
	return error?.error === "InvalidSwap" || /InvalidSwap/.test(error?.message ?? "");
}

// A record write to the collection is authorized by the transitional generic
// grant, a repo:* wildcard, or an exact repo:<collection> grant. Query
// attributes after ? (action=create&…) are ignored: their presence still names
// the collection, and the PDS remains the final authority on the write.
export function canWriteCollection(scope, collection) {
	const tokens = scopeSet(scope);
	if (tokens.has("transition:generic")) return true;
	for (const token of tokens) {
		if (!token.startsWith("repo:")) continue;
		const nsid = token.slice("repo:".length).split("?")[0];
		if (nsid === "*" || nsid === collection) return true;
	}
	return false;
}

export function scopeError(collection) {
	return profileError(
		`the OAuth session cannot write ${collection}`,
		"profile-scope-insufficient",
		{
			stage: "session",
			remediation: `re-authenticate with a grant that includes the repo:${collection} scope (run rook login)`,
		},
	);
}

// Auth or scope rejection from the PDS. The proactive canWriteCollection guard
// covers the known-scope case; this maps a live rejection to the same
// actionable, collection-named error.
function isAuthScopeError(error) {
	if (error?.status === 401 || error?.status === 403) return true;
	const name = String(error?.error ?? "");
	const message = String(error?.message ?? "");
	if (
		/InvalidToken|InsufficientScope|Forbidden|AuthMissing|AuthRequired|PermissionDenied/i.test(name)
	) {
		return true;
	}
	return /scope|not permitted|insufficient/i.test(message);
}

function mapWriteError(error, retry) {
	if (isAuthScopeError(error)) return scopeError(PROFILE_COLLECTION);
	return profileError("the profile write was rejected", "profile-write-failed", {
		remediation: retry,
		cause: error,
	});
}

export function expectedProfileUri(repo) {
	return `at://${repo}/${PROFILE_COLLECTION}/${PROFILE_RKEY}`;
}

// A comma-joined or repeated flag, or a JSON array, reduced to a trimmed,
// non-empty list. Undefined input (flag absent) stays undefined so a publish
// can fall back to a --file value instead of clobbering it with an empty list.
export function normalizeList(value) {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) return undefined;
	return value
		.map((item) => (typeof item === "string" ? item.trim() : ""))
		.filter((item) => item.length > 0);
}

function isValidUri(value) {
	if (!nonempty(value)) return false;
	try {
		return nonempty(new URL(value).protocol);
	} catch {
		return false;
	}
}

// Canonicalize for a content-equality check so an unchanged re-publish adopts
// the existing record instead of issuing a redundant write.
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
		return out;
	}
	return value;
}

export function recordsEqual(a, b) {
	return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

// Build the validated record from resolved inputs. displayName and description
// are required; tags cap at MAX_TAGS; links must be valid URIs. createdAt is
// preserved from the existing record when present, and the resolved avatar blob
// (uploaded, preserved, or dropped) is supplied by the caller.
export function buildProfileRecord(inputs, { existing, avatar, now } = {}) {
	if (!nonempty(inputs.displayName)) {
		throw profileError("displayName is required", "profile-invalid", {
			remediation: "pass --display-name or set displayName in --file",
		});
	}
	if (!nonempty(inputs.description)) {
		throw profileError("description is required", "profile-invalid", {
			remediation: "pass --description or set description in --file",
		});
	}

	const record = {
		$type: PROFILE_COLLECTION,
		displayName: inputs.displayName.trim(),
		description: inputs.description.trim(),
	};

	if (inputs.operator !== undefined) {
		if (typeof inputs.operator !== "string") {
			throw profileError("operator must be a string", "profile-invalid");
		}
		const operator = inputs.operator.trim();
		if (operator.length > 0) record.operator = operator;
	}

	const links = normalizeList(inputs.links);
	if (links && links.length > 0) {
		for (const link of links) {
			if (!isValidUri(link)) {
				throw profileError(`link is not a valid URI: ${link}`, "profile-invalid-link", {
					remediation: "pass absolute URIs like https://example.com",
				});
			}
		}
		record.links = links;
	}

	const tags = normalizeList(inputs.tags);
	if (tags && tags.length > 0) {
		if (tags.length > MAX_TAGS) {
			throw profileError(
				`too many tags: ${tags.length} (max ${MAX_TAGS})`,
				"profile-too-many-tags",
				{
					remediation: `pass at most ${MAX_TAGS} tags`,
				},
			);
		}
		record.tags = tags;
	}

	if (avatar !== undefined) record.avatar = avatar;

	record.createdAt =
		existing && nonempty(existing.createdAt)
			? existing.createdAt
			: (now ?? new Date().toISOString());
	return record;
}

// Parse a --file JSON object into overridable profile fields. Avatar and
// createdAt are managed separately (uploaded/preserved) and ignored here.
export async function readProfileFile(filePath, dependencies = {}) {
	let raw;
	try {
		raw = await (dependencies.readFile ?? readFile)(filePath, "utf8");
	} catch (cause) {
		throw profileError(`could not read --file ${filePath}`, "profile-file-unreadable", { cause });
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw profileError("--file is not valid JSON", "profile-file-invalid", { cause });
	}
	if (!plainObject(parsed)) {
		throw profileError("--file must contain a JSON object", "profile-file-invalid");
	}
	const listField = (name) => {
		if (parsed[name] === undefined) return undefined;
		if (!Array.isArray(parsed[name])) {
			throw profileError(`--file ${name} must be an array`, "profile-file-invalid");
		}
		return parsed[name];
	};
	return {
		displayName: typeof parsed.displayName === "string" ? parsed.displayName : undefined,
		description: typeof parsed.description === "string" ? parsed.description : undefined,
		operator: typeof parsed.operator === "string" ? parsed.operator : undefined,
		links: listField("links"),
		tags: listField("tags"),
	};
}

export async function uploadAvatar(agent, filePath, dependencies = {}) {
	const mime = IMAGE_MIME[extname(filePath).toLowerCase()];
	if (!mime) {
		throw profileError(
			`unsupported avatar image type for ${filePath}; use png, jpg, gif, or webp`,
			"profile-avatar-unsupported",
		);
	}
	let bytes;
	try {
		bytes = await (dependencies.readFile ?? readFile)(filePath);
	} catch (cause) {
		throw profileError(`could not read avatar file ${filePath}`, "profile-avatar-unreadable", {
			cause,
		});
	}
	let response;
	try {
		response = await agent.com.atproto.repo.uploadBlob(bytes, { encoding: mime });
	} catch (cause) {
		throw profileError("avatar upload was rejected", "profile-avatar-rejected", { cause });
	}
	const blob = response?.data?.blob;
	if (!plainObject(blob)) {
		throw profileError("avatar upload returned no blob reference", "profile-avatar-rejected");
	}
	return blob;
}

export async function readProfile(agent, repo, _dependencies = {}) {
	if (!validDid(repo)) throw profileError("profile request is invalid", "profile-invalid");
	let response;
	try {
		response = await agent.com.atproto.repo.getRecord({
			repo,
			collection: PROFILE_COLLECTION,
			rkey: PROFILE_RKEY,
		});
	} catch (error) {
		if (isRecordNotFound(error)) return undefined;
		throw profileError("could not read the profile record", "profile-read-failed", {
			cause: error,
		});
	}
	const data = response?.data;
	if (!plainObject(data) || !plainObject(data.value) || data.uri !== expectedProfileUri(repo)) {
		throw profileError("profile record response is invalid", "profile-invalid-response");
	}
	return { uri: data.uri, cid: data.cid, value: data.value };
}

export async function putProfile(agent, repo, record, swapRecord, _dependencies = {}) {
	if (!validDid(repo)) throw profileError("profile request is invalid", "profile-invalid");
	if (repo !== agent.did) {
		throw profileError(
			"profile write target must match the authenticated agent",
			"profile-identity-mismatch",
		);
	}
	let response;
	try {
		response = await agent.com.atproto.repo.putRecord({
			repo,
			collection: PROFILE_COLLECTION,
			rkey: PROFILE_RKEY,
			record,
			...(swapRecord !== undefined ? { swapRecord } : {}),
			validate: false,
		});
	} catch (error) {
		if (isSwapConflict(error)) {
			throw profileError("profile changed since it was read", "profile-cas-conflict", {
				remediation: "run rook profile publish again",
				cause: error,
			});
		}
		throw mapWriteError(error, "run rook profile publish");
	}
	const data = response?.data;
	if (!plainObject(data) || data.uri !== expectedProfileUri(repo) || !nonempty(data.cid)) {
		throw profileError("profile record response is invalid", "profile-invalid-response");
	}
	return { uri: data.uri, cid: data.cid };
}

export async function deleteProfile(agent, repo, swapRecord, _dependencies = {}) {
	if (!validDid(repo)) throw profileError("profile request is invalid", "profile-invalid");
	if (repo !== agent.did) {
		throw profileError(
			"profile write target must match the authenticated agent",
			"profile-identity-mismatch",
		);
	}
	try {
		await agent.com.atproto.repo.deleteRecord({
			repo,
			collection: PROFILE_COLLECTION,
			rkey: PROFILE_RKEY,
			...(swapRecord !== undefined ? { swapRecord } : {}),
		});
	} catch (error) {
		if (isSwapConflict(error)) {
			throw profileError("profile changed since it was read", "profile-cas-conflict", {
				remediation: "run rook profile remove again",
				cause: error,
			});
		}
		throw mapWriteError(error, "run rook profile remove");
	}
}
