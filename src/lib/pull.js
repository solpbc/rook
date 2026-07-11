// SPDX-License-Identifier: AGPL-3.0-only

import { TID } from "@atproto/common-web";
import { RookError } from "./error-format.js";
import { listAllRecords } from "./records.js";

export const PULL_COLLECTION = "sh.tangled.repo.pull";

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

function pullError(message, code = "pull-record-rejected", options = {}) {
	return new RookError(message, { code, ...options });
}

function isRecordNotFound(error) {
	return (
		error?.status === 400 &&
		(error?.error === "RecordNotFound" || /RecordNotFound/.test(error?.message ?? ""))
	);
}

function isSwapConflict(error) {
	return error?.error === "InvalidSwap" || /InvalidSwap/.test(error?.message ?? "");
}

export function nextRkey() {
	return TID.nextStr();
}

export function expectedPullUri(repo, rkey) {
	return `at://${repo}/${PULL_COLLECTION}/${rkey}`;
}

export async function uploadPatchBlob(agent, gzipBytes, _dependencies = {}) {
	let response;
	try {
		response = await agent.com.atproto.repo.uploadBlob(gzipBytes, { encoding: "application/gzip" });
	} catch (cause) {
		throw pullError("patch blob upload was rejected", "pull-blob-rejected", { cause });
	}
	const blob = response?.data?.blob;
	if (!plainObject(blob)) {
		throw pullError("patch blob upload returned no blob reference", "pull-blob-rejected");
	}
	return blob;
}

export async function readPullRecord(agent, { repo, rkey }, _dependencies = {}) {
	if (!validDid(repo) || !validRecordKey(rkey)) {
		throw pullError("pull record request is invalid");
	}
	let response;
	try {
		response = await agent.com.atproto.repo.getRecord({ repo, collection: PULL_COLLECTION, rkey });
	} catch (error) {
		if (isRecordNotFound(error)) return undefined;
		throw pullError("pull record read was rejected", "pull-record-rejected", { cause: error });
	}
	const data = response?.data;
	if (!plainObject(data) || !plainObject(data.value) || data.uri !== expectedPullUri(repo, rkey)) {
		throw pullError("pull record response is invalid", "pull-record-invalid-response");
	}
	return { uri: data.uri, cid: data.cid, value: data.value };
}

export async function listPullRecords(agent, repo, dependencies = {}) {
	return listAllRecords(agent, repo, PULL_COLLECTION, { ...dependencies, listCodePrefix: "pull" });
}

// The effective self-pull identity. An omitted source.repo means the target repo;
// an omitted source object entirely (a patch-based pull) has no source branch and
// therefore never matches a branch-based wanted tuple.
export function pullTuple(record) {
	if (!plainObject(record) || !plainObject(record.target)) return undefined;
	const targetDid = record.target.repo;
	const targetBranch = record.target.branch;
	if (!validDid(targetDid) || !nonempty(targetBranch)) return undefined;
	const source = record.source;
	if (source === undefined || source === null) {
		return { sourceDid: targetDid, sourceBranch: undefined, targetDid, targetBranch };
	}
	if (!plainObject(source)) return undefined;
	const sourceBranch = source.branch;
	const sourceDid = source.repo ?? targetDid;
	if (!nonempty(sourceBranch) || !validDid(sourceDid)) return undefined;
	return { sourceDid, sourceBranch, targetDid, targetBranch };
}

export function pullMatchesTuple(record, wanted) {
	const tuple = pullTuple(record);
	if (!tuple) return false;
	return (
		tuple.sourceDid === wanted.sourceDid &&
		tuple.sourceBranch === wanted.sourceBranch &&
		tuple.targetDid === wanted.targetDid &&
		tuple.targetBranch === wanted.targetBranch
	);
}

export function buildPullRecord({
	title,
	body,
	targetDid,
	targetBranch,
	sourceBranch,
	rounds,
	createdAt,
}) {
	const record = {
		$type: PULL_COLLECTION,
		title,
		// Same-repo branch source: source.repo omitted (means the target repo).
		source: { branch: sourceBranch },
		// Emit the repoDid compat shadow beside repo, exactly as the Tangled appview
		// does, so knots that predate the canonical `repo` field do not drop the pull.
		target: { repo: targetDid, branch: targetBranch, repoDid: targetDid },
		rounds,
		createdAt,
	};
	if (nonempty(body)) record.body = body;
	return record;
}

export async function createPullRecord(agent, { repo, rkey, record }, _dependencies = {}) {
	if (!validDid(repo) || !validRecordKey(rkey)) throw pullError("pull record request is invalid");
	if (repo !== agent.did) throw pullError("pull write target must match the authenticated agent");
	let response;
	try {
		response = await agent.com.atproto.repo.putRecord({
			repo,
			collection: PULL_COLLECTION,
			rkey,
			record,
			validate: false,
		});
	} catch (cause) {
		throw pullError("pull record create was rejected", "pull-record-rejected", { cause });
	}
	const data = response?.data;
	if (!plainObject(data) || data.uri !== expectedPullUri(repo, rkey) || !nonempty(data.cid)) {
		throw pullError("pull record response is invalid", "pull-record-invalid-response");
	}
	return { uri: data.uri, cid: data.cid };
}

export async function appendPullRound(
	agent,
	{ repo, rkey, priorRecord, round, swapCid },
	_dependencies = {},
) {
	if (!validDid(repo) || !validRecordKey(rkey)) throw pullError("pull record request is invalid");
	if (repo !== agent.did) throw pullError("pull write target must match the authenticated agent");
	if (!plainObject(priorRecord) || !Array.isArray(priorRecord.rounds)) {
		throw pullError("pull record is not refreshable", "pull-record-invalid-response");
	}
	const record = { ...priorRecord, rounds: [...priorRecord.rounds, round] };
	let response;
	try {
		response = await agent.com.atproto.repo.putRecord({
			repo,
			collection: PULL_COLLECTION,
			rkey,
			record,
			swapRecord: swapCid,
			validate: false,
		});
	} catch (error) {
		if (isSwapConflict(error)) {
			throw pullError("pull record changed since it was read", "pull-cas-conflict", {
				remediation: "run rook pr again",
				cause: error,
			});
		}
		throw pullError("pull record update was rejected", "pull-record-rejected", { cause: error });
	}
	const data = response?.data;
	if (!plainObject(data) || data.uri !== expectedPullUri(repo, rkey) || !nonempty(data.cid)) {
		throw pullError("pull record response is invalid", "pull-record-invalid-response");
	}
	return { uri: data.uri, cid: data.cid };
}
