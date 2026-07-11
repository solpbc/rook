// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";
import {
	appendPullRound,
	buildPullRecord,
	createPullRecord,
	listPullRecords,
	pullMatchesTuple,
	pullTuple,
	readPullRecord,
	uploadPatchBlob,
} from "../src/lib/pull.js";

const REPO = "did:plc:testrook";
const COLLECTION = "sh.tangled.repo.pull";

function recordAgent({ records = new Map(), uploads = [], puts = [] } = {}) {
	let counter = records.size;
	return {
		did: REPO,
		com: {
			atproto: {
				repo: {
					uploadBlob: async (bytes, opts) => {
						uploads.push({ length: bytes.length, encoding: opts?.encoding });
						return {
							data: {
								blob: { $type: "blob", ref: { $link: "bafblob" }, mimeType: opts?.encoding },
							},
						};
					},
					getRecord: async ({ repo, collection, rkey }) => {
						const entry = records.get(rkey);
						if (!entry) {
							throw Object.assign(new Error("RecordNotFound"), {
								status: 400,
								error: "RecordNotFound",
							});
						}
						return {
							data: {
								uri: `at://${repo}/${collection}/${rkey}`,
								cid: entry.cid,
								value: entry.value,
							},
						};
					},
					putRecord: async ({ repo, collection, rkey, record, swapRecord }) => {
						const existing = records.get(rkey);
						if (swapRecord !== undefined && (!existing || existing.cid !== swapRecord)) {
							throw Object.assign(new Error("InvalidSwap"), { status: 400, error: "InvalidSwap" });
						}
						counter += 1;
						const cid = `bafyreicid${counter}`;
						records.set(rkey, { cid, value: record });
						puts.push({ rkey, record, swapRecord });
						return { data: { uri: `at://${repo}/${collection}/${rkey}`, cid } };
					},
				},
			},
		},
	};
}

function pagedListAgent(pages) {
	let index = 0;
	return {
		did: REPO,
		com: {
			atproto: {
				repo: {
					listRecords: async () => {
						const page = pages[index];
						index += 1;
						return { data: page };
					},
				},
			},
		},
	};
}

test("uploadPatchBlob uploads with application/gzip and returns the blob ref", async () => {
	const uploads = [];
	const agent = recordAgent({ uploads });
	const blob = await uploadPatchBlob(agent, Buffer.from("gzip-bytes"));
	assert.equal(uploads[0].encoding, "application/gzip");
	assert.equal(blob.$type, "blob");
});

test("readPullRecord returns the record or undefined on RecordNotFound", async () => {
	const records = new Map([
		["r1", { cid: "bafyreicid1", value: { $type: COLLECTION, title: "t" } }],
	]);
	const agent = recordAgent({ records });
	const found = await readPullRecord(agent, { repo: REPO, rkey: "r1" });
	assert.equal(found.value.title, "t");
	assert.equal(found.cid, "bafyreicid1");
	assert.equal(await readPullRecord(agent, { repo: REPO, rkey: "missing" }), undefined);
});

test("listPullRecords exhausts every page and rejects a repeated cursor", async () => {
	const good = pagedListAgent([
		{
			records: [{ uri: `at://${REPO}/${COLLECTION}/a`, cid: "c1", value: { n: 1 } }],
			cursor: "p2",
		},
		{ records: [{ uri: `at://${REPO}/${COLLECTION}/b`, cid: "c2", value: { n: 2 } }], cursor: "" },
	]);
	const all = await listPullRecords(good, REPO);
	assert.equal(all.length, 2);

	const looping = pagedListAgent([
		{ records: [], cursor: "same" },
		{ records: [], cursor: "same" },
	]);
	await assert.rejects(
		listPullRecords(looping, REPO),
		(error) => error.code === "pull-list-failed",
	);
});

test("pullTuple resolves omitted source.repo to the target and drops patch-based pulls", () => {
	const knot = "did:plc:knot";
	const branchBased = { target: { repo: knot, branch: "main" }, source: { branch: "feature" } };
	assert.deepEqual(pullTuple(branchBased), {
		sourceDid: knot,
		sourceBranch: "feature",
		targetDid: knot,
		targetBranch: "main",
	});
	const patchBased = { target: { repo: knot, branch: "main" } };
	assert.equal(pullTuple(patchBased).sourceBranch, undefined);

	const wanted = {
		sourceDid: knot,
		sourceBranch: "feature",
		targetDid: knot,
		targetBranch: "main",
	};
	assert.equal(pullMatchesTuple(branchBased, wanted), true);
	assert.equal(pullMatchesTuple(patchBased, wanted), false);
	// Fork source (different source repo) does not match a same-repo wanted tuple.
	assert.equal(
		pullMatchesTuple(
			{
				target: { repo: knot, branch: "main" },
				source: { branch: "feature", repo: "did:plc:fork" },
			},
			wanted,
		),
		false,
	);
	// Different target branch does not match.
	assert.equal(
		pullMatchesTuple(
			{ target: { repo: knot, branch: "other" }, source: { branch: "feature" } },
			wanted,
		),
		false,
	);
});

test("buildPullRecord omits source.repo and shadows target.repoDid", () => {
	const record = buildPullRecord({
		title: "feature → main",
		body: "rook pull",
		targetDid: "did:plc:knot",
		targetBranch: "main",
		sourceBranch: "feature",
		rounds: [{ createdAt: "2026-07-11T00:00:00.000Z", patchBlob: { $type: "blob" } }],
		createdAt: "2026-07-11T00:00:00.000Z",
	});
	assert.equal(record.$type, COLLECTION);
	assert.deepEqual(record.source, { branch: "feature" });
	assert.equal(record.target.repo, "did:plc:knot");
	assert.equal(record.target.repoDid, "did:plc:knot");
	assert.equal(record.body, "rook pull");
	assert.equal(record.rounds.length, 1);
});

test("createPullRecord returns the durable uri and cid", async () => {
	const agent = recordAgent();
	const { uri, cid } = await createPullRecord(agent, {
		repo: REPO,
		rkey: "new1",
		record: { $type: COLLECTION, title: "t" },
	});
	assert.equal(uri, `at://${REPO}/${COLLECTION}/new1`);
	assert.match(cid, /^bafyreicid/);
});

test("appendPullRound appends exactly one round, preserves fields, and honours CAS", async () => {
	const priorRecord = {
		$type: COLLECTION,
		title: "feature → main",
		source: { branch: "feature" },
		target: { repo: "did:plc:knot", branch: "main", repoDid: "did:plc:knot" },
		createdAt: "2026-07-11T00:00:00.000Z",
		rounds: [{ createdAt: "2026-07-11T00:00:00.000Z", patchBlob: { $type: "blob" } }],
	};
	const records = new Map([["p1", { cid: "bafcurrent", value: priorRecord }]]);
	const puts = [];
	const agent = recordAgent({ records, puts });
	const round = { createdAt: "2026-07-12T00:00:00.000Z", patchBlob: { $type: "blob" } };
	const result = await appendPullRound(agent, {
		repo: REPO,
		rkey: "p1",
		priorRecord,
		round,
		swapCid: "bafcurrent",
	});
	assert.equal(result.uri, `at://${REPO}/${COLLECTION}/p1`);
	const written = puts[0].record;
	assert.equal(written.rounds.length, 2);
	assert.equal(written.title, "feature → main");
	assert.deepEqual(written.source, { branch: "feature" });
	assert.equal(written.createdAt, "2026-07-11T00:00:00.000Z");
	assert.equal(puts[0].swapRecord, "bafcurrent");

	// A stale swap CID must fail without a silent overwrite.
	await assert.rejects(
		appendPullRound(agent, { repo: REPO, rkey: "p1", priorRecord, round, swapCid: "stale" }),
		(error) => error.code === "pull-cas-conflict" && typeof error.remediation === "string",
	);
});
