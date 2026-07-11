// SPDX-License-Identifier: AGPL-3.0-only

import path from "node:path";
import { RookError } from "./error-format.js";
import { atomicWriteFile, readJsonFile } from "./storage.js";

const ALLOWED_KEYS = new Set([
	"version",
	"upstreamUrl",
	"upstreamDefaultBranch",
	"knotRepoName",
	"knotRepoDid",
	"rookRemoteUrl",
	"lastPushedBranch",
	"lastPushedTip",
	"pullUri",
	"pullRkey",
	"pullCid",
	"pullCreatedAt",
	"pullRoundTip",
	"renderedPullUrl",
	"capUri",
	"capRkey",
	"capCid",
	"capRef",
	"capCreatedAt",
]);

const REQUIRED_STRING_KEYS = [
	"upstreamUrl",
	"upstreamDefaultBranch",
	"knotRepoName",
	"knotRepoDid",
	"rookRemoteUrl",
];

const PULL_COLLECTION = "sh.tangled.repo.pull";
const CAP_COLLECTION = "org.v-it.cap";
const PULL_GROUP = ["pullUri", "pullRkey", "pullCid", "pullCreatedAt"];
const CAP_GROUP = ["capUri", "capRkey", "capCid", "capRef", "capCreatedAt"];
const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const RECORD_KEY_PATTERN = /^[A-Za-z0-9_~.:-]+$/;
const CID_PATTERN = /^[A-Za-z0-9]{8,512}$/;
const CAP_REF_PATTERN = /^[a-z]+-[a-z]+-[a-z]+$/;

function invalidState(message = "repository state is invalid", options = {}) {
	return new RookError(message, { ...options, code: "state-invalid" });
}

function isPlainObject(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function requireNonemptyString(value) {
	return typeof value === "string" && value.length > 0;
}

function validateUpstreamUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw invalidState("repository state upstream URL is invalid");
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== "" ||
		url.pathname === "/"
	) {
		throw invalidState("repository state upstream URL is invalid");
	}
	const canonical = `https://${url.host.toLowerCase()}${url.pathname}`;
	if (canonical !== value) throw invalidState("repository state upstream URL is not canonical");
}

function validateRepoDid(value) {
	if (!/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(value)) {
		throw invalidState("repository state repo DID is invalid");
	}
}

function validateRookRemoteUrl(value, repoDid) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw invalidState("repository state rook remote URL is invalid");
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== "" ||
		url.pathname !== `/${repoDid}`
	) {
		throw invalidState("repository state rook remote URL is invalid");
	}
	const canonical = `https://${url.host.toLowerCase()}/${repoDid}`;
	if (canonical !== value) throw invalidState("repository state rook remote URL is not canonical");
}

function validRecordKey(value) {
	return (
		requireNonemptyString(value) &&
		value.length <= 512 &&
		value !== "." &&
		value !== ".." &&
		RECORD_KEY_PATTERN.test(value)
	);
}

function validateAtUri(value, collection, rkey, label) {
	if (!requireNonemptyString(value) || !value.startsWith("at://")) {
		throw invalidState(`repository state ${label} is invalid`);
	}
	const parts = value.slice("at://".length).split("/");
	if (
		parts.length !== 3 ||
		!DID_PATTERN.test(parts[0]) ||
		parts[1] !== collection ||
		parts[2] !== rkey
	) {
		throw invalidState(`repository state ${label} is invalid`);
	}
}

function validateCid(value, label) {
	if (!requireNonemptyString(value) || !CID_PATTERN.test(value)) {
		throw invalidState(`repository state ${label} is invalid`);
	}
}

function validateTimestamp(value, label) {
	if (!requireNonemptyString(value) || !Number.isFinite(new Date(value).getTime())) {
		throw invalidState(`repository state ${label} is invalid`);
	}
}

function validateRenderedPullUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw invalidState("repository state rendered pull URL is invalid");
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== "" ||
		!/^\/[^/]+\/[^/]+\/pulls\/[1-9][0-9]*$/.test(url.pathname)
	) {
		throw invalidState("repository state rendered pull URL is invalid");
	}
	const canonical = `https://${url.host.toLowerCase()}${url.pathname}`;
	if (canonical !== value) {
		throw invalidState("repository state rendered pull URL is not canonical");
	}
}

function validateGroups(value) {
	const presentPull = PULL_GROUP.filter((key) => Object.hasOwn(value, key));
	if (presentPull.length !== 0 && presentPull.length !== PULL_GROUP.length) {
		throw invalidState("repository state pull fields are incomplete");
	}
	const hasPull = presentPull.length === PULL_GROUP.length;
	if (hasPull) {
		if (!validRecordKey(value.pullRkey)) {
			throw invalidState("repository state pull record key is invalid");
		}
		validateAtUri(value.pullUri, PULL_COLLECTION, value.pullRkey, "pull URI");
		validateCid(value.pullCid, "pull CID");
		validateTimestamp(value.pullCreatedAt, "pull timestamp");
	}

	if (Object.hasOwn(value, "pullRoundTip")) {
		if (!hasPull) throw invalidState("repository state pull round tip requires pull fields");
		if (!/^[0-9a-f]{40}$/.test(value.pullRoundTip)) {
			throw invalidState("repository state pull round tip is invalid");
		}
	}

	const hasRendered = Object.hasOwn(value, "renderedPullUrl");
	if (hasRendered) {
		if (!hasPull) throw invalidState("repository state rendered pull URL requires pull fields");
		validateRenderedPullUrl(value.renderedPullUrl);
	}

	const presentCap = CAP_GROUP.filter((key) => Object.hasOwn(value, key));
	if (presentCap.length !== 0 && presentCap.length !== CAP_GROUP.length) {
		throw invalidState("repository state cap fields are incomplete");
	}
	if (presentCap.length === CAP_GROUP.length) {
		if (!hasPull || !hasRendered) {
			throw invalidState("repository state cap fields require a resolved pull");
		}
		if (!validRecordKey(value.capRkey)) {
			throw invalidState("repository state cap record key is invalid");
		}
		validateAtUri(value.capUri, CAP_COLLECTION, value.capRkey, "cap URI");
		validateCid(value.capCid, "cap CID");
		if (!CAP_REF_PATTERN.test(value.capRef)) {
			throw invalidState("repository state cap ref is invalid");
		}
		validateTimestamp(value.capCreatedAt, "cap timestamp");
	}
}

function validateState(value) {
	if (!isPlainObject(value)) throw invalidState();
	for (const key of Object.keys(value)) {
		if (!ALLOWED_KEYS.has(key)) throw invalidState("repository state contains unsupported fields");
	}
	if (value.version !== 1) throw invalidState("repository state version is unsupported");
	for (const key of REQUIRED_STRING_KEYS) {
		if (!requireNonemptyString(value[key])) {
			throw invalidState("repository state contains invalid fields");
		}
	}
	validateUpstreamUrl(value.upstreamUrl);
	validateRepoDid(value.knotRepoDid);
	validateRookRemoteUrl(value.rookRemoteUrl, value.knotRepoDid);

	const hasBranch = Object.hasOwn(value, "lastPushedBranch");
	const hasTip = Object.hasOwn(value, "lastPushedTip");
	if (hasBranch !== hasTip) throw invalidState("repository state push proof is incomplete");
	if (hasBranch) {
		if (
			!requireNonemptyString(value.lastPushedBranch) ||
			!/^[0-9a-f]{40}$/.test(value.lastPushedTip)
		) {
			throw invalidState("repository state push proof is invalid");
		}
	}
	validateGroups(value);
	return { ...value };
}

export function repoStatePath(gitCommonDir) {
	if (!requireNonemptyString(gitCommonDir) || !path.isAbsolute(gitCommonDir)) {
		throw invalidState("git common directory must be an absolute path");
	}
	return path.join(gitCommonDir, "rook", "state.json");
}

export async function readRepoState(gitCommonDir, dependencies = {}) {
	let value;
	try {
		value = await readJsonFile(repoStatePath(gitCommonDir), dependencies.fs);
	} catch (cause) {
		throw invalidState("repository state could not be read", { cause });
	}
	return value === undefined ? undefined : validateState(value);
}

export async function writeRepoState(gitCommonDir, patch, dependencies = {}) {
	if (!isPlainObject(patch)) throw invalidState("repository state patch is invalid");
	for (const [key, value] of Object.entries(patch)) {
		if (!ALLOWED_KEYS.has(key) || value === undefined) {
			throw invalidState("repository state patch contains unsupported fields");
		}
	}
	if (Object.hasOwn(patch, "version") && patch.version !== 1) {
		throw invalidState("repository state version is unsupported");
	}
	const existing = await readRepoState(gitCommonDir, dependencies);
	const state = validateState({ ...(existing ?? {}), ...patch, version: 1 });
	try {
		await atomicWriteFile(
			repoStatePath(gitCommonDir),
			`${JSON.stringify(state, null, 2)}\n`,
			dependencies.fs,
		);
	} catch (cause) {
		throw new RookError("repository state could not be written", {
			cause,
			code: "state-write-failed",
		});
	}
	return state;
}
