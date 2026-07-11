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
]);

const REQUIRED_STRING_KEYS = [
	"upstreamUrl",
	"upstreamDefaultBranch",
	"knotRepoName",
	"knotRepoDid",
	"rookRemoteUrl",
];

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
