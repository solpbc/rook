// SPDX-License-Identifier: AGPL-3.0-only

import { RookError } from "./error-format.js";

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;

function plainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value) {
	return typeof value === "string" && value.length > 0;
}

// Exhaustive listing of one collection in one repo, mirroring the knot member
// pagination loop: bounded pages, repeat-cursor detection, and an overall
// deadline. The code prefix lets callers surface collection-specific error codes.
export async function listAllRecords(agent, repo, collection, dependencies = {}) {
	const prefix = dependencies.listCodePrefix ?? "record";
	const failed = `${prefix}-list-failed`;
	const invalid = `${prefix}-list-invalid-response`;
	if (!nonempty(repo) || !DID.test(repo)) {
		throw new RookError("record listing request is invalid", { code: failed });
	}
	const clock = dependencies.clock ?? (() => Date.now());
	const deadline = clock() + (dependencies.listTimeoutMs ?? 30_000);
	const maxPages = dependencies.listMaxPages ?? 1000;
	const records = [];
	const cursors = new Set();
	let cursor;
	for (let page = 0; page < maxPages; page += 1) {
		if (clock() > deadline)
			throw new RookError("record listing did not converge", { code: failed });
		let response;
		try {
			response = await agent.com.atproto.repo.listRecords({
				repo,
				collection,
				limit: 100,
				...(cursor ? { cursor } : {}),
			});
		} catch (cause) {
			throw new RookError("could not list records", { code: failed, cause });
		}
		const data = response?.data;
		if (!plainObject(data) || !Array.isArray(data.records)) {
			throw new RookError("record listing is invalid", { code: invalid });
		}
		for (const record of data.records) {
			if (!plainObject(record) || !nonempty(record.uri) || !plainObject(record.value)) {
				throw new RookError("record listing is invalid", { code: invalid });
			}
			records.push({ uri: record.uri, cid: record.cid, value: record.value });
		}
		const next = data.cursor;
		if (next === undefined || next === null || next === "") return records;
		if (typeof next !== "string" || cursors.has(next)) {
			throw new RookError("record listing did not converge", { code: failed });
		}
		cursors.add(next);
		cursor = next;
	}
	throw new RookError("record listing did not converge", { code: failed });
}
