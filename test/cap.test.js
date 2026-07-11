// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";
import {
	capMatches,
	capUnchanged,
	deriveBeacon,
	publishOrRefreshCap,
	resolveRequestCap,
} from "../src/lib/cap.js";

const REPO = "did:plc:testrook";
const CAP = "org.v-it.cap";
const RENDERED = "https://tangled.org/did:plc:testrook/widget/pulls/5";
const BEACON = "vit:github.com/owner/widget";
const EXTERNAL = {
	uri: RENDERED,
	title: "feature → main",
	description: "rook pull for github.com/owner/widget",
};

function capAgent({ records = new Map(), puts = [] } = {}) {
	let counter = records.size;
	return {
		did: REPO,
		com: {
			atproto: {
				repo: {
					putRecord: async ({ repo, collection, rkey, record, swapRecord }) => {
						const existing = records.get(rkey);
						if (swapRecord !== undefined && (!existing || existing.cid !== swapRecord)) {
							throw Object.assign(new Error("InvalidSwap"), { status: 400, error: "InvalidSwap" });
						}
						counter += 1;
						const cid = `bafcapcid${counter}`;
						records.set(rkey, { cid, value: record });
						puts.push({ rkey, record, swapRecord });
						return { data: { uri: `at://${repo}/${collection}/${rkey}`, cid } };
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
				},
			},
		},
	};
}

test("deriveBeacon builds vit beacons from canonical upstream URLs", () => {
	assert.equal(deriveBeacon("https://github.com/owner/repo.git"), "vit:github.com/owner/repo");
	assert.equal(deriveBeacon("https://github.com/owner/repo"), "vit:github.com/owner/repo");
	assert.equal(deriveBeacon("https://example.org/solo"), "vit:example.org//solo");
	assert.throws(
		() => deriveBeacon("https://user:pass@github.com/o/r"),
		(e) => e.code === "beacon-invalid",
	);
});

test("capMatches keys off rendered URL, beacon, and request parent", () => {
	const record = { embed: { external: { uri: RENDERED } }, beacon: BEACON };
	assert.equal(capMatches(record, { renderedPullUrl: RENDERED, beacon: BEACON }), true);
	assert.equal(
		capMatches(record, { renderedPullUrl: "https://x/other/pulls/1", beacon: BEACON }),
		false,
	);
	assert.equal(capMatches(record, { renderedPullUrl: RENDERED, beacon: "vit:other//x" }), false);
	const reply = {
		embed: { external: { uri: RENDERED } },
		beacon: BEACON,
		reply: { parent: { uri: "at://req" } },
	};
	assert.equal(
		capMatches(reply, { renderedPullUrl: RENDERED, beacon: BEACON, requestParentUri: "at://req" }),
		true,
	);
	assert.equal(
		capMatches(record, { renderedPullUrl: RENDERED, beacon: BEACON, requestParentUri: "at://req" }),
		false,
	);
});

test("capUnchanged detects identical overridable content", () => {
	const desired = {
		embedExternal: EXTERNAL,
		title: EXTERNAL.title,
		description: EXTERNAL.description,
		text: "",
		kind: "feat",
	};
	const record = {
		embed: { external: EXTERNAL },
		title: EXTERNAL.title,
		description: EXTERNAL.description,
		text: "",
		kind: "feat",
	};
	assert.equal(capUnchanged(record, desired), true);
	assert.equal(capUnchanged({ ...record, title: "changed" }, desired), false);
	assert.equal(capUnchanged({ ...record, kind: "fix" }, desired), false);
});

test("resolveRequestCap returns strong parent and root references", async () => {
	const rootRef = { uri: "at://did:plc:req/org.v-it.cap/root", cid: "bafroot" };
	const records = new Map([
		["threaded", { cid: "bafparent1", value: { $type: CAP, reply: { root: rootRef } } }],
		["standalone", { cid: "bafparent2", value: { $type: CAP } }],
	]);
	const agent = {
		com: {
			atproto: {
				repo: {
					getRecord: capAgent({ records }).com.atproto.repo.getRecord,
				},
			},
		},
	};

	const threaded = await resolveRequestCap(agent, `at://${REPO}/${CAP}/threaded`);
	assert.deepEqual(threaded.parent, { uri: `at://${REPO}/${CAP}/threaded`, cid: "bafparent1" });
	assert.deepEqual(threaded.root, rootRef);

	const standalone = await resolveRequestCap(agent, `at://${REPO}/${CAP}/standalone`);
	assert.deepEqual(standalone.parent, standalone.root);

	await assert.rejects(
		resolveRequestCap(agent, `at://${REPO}/${CAP}/missing`),
		(error) => error.code === "request-cap-unresolved",
	);
	await assert.rejects(
		resolveRequestCap(agent, "not-an-at-uri"),
		(error) => error.code === "request-cap-unresolved",
	);
});

test("resolveRequestCap rejects a non-cap collection", async () => {
	const records = new Map([["x", { cid: "bafx", value: { $type: "sh.tangled.repo.pull" } }]]);
	const agent = capAgent({ records });
	await assert.rejects(
		resolveRequestCap(agent, `at://${REPO}/${CAP}/x`),
		(error) => error.code === "request-cap-unresolved",
	);
});

test("publishOrRefreshCap creates a cap through vit publishCap", async () => {
	const puts = [];
	const agent = capAgent({ puts });
	const result = await publishOrRefreshCap(agent, {
		repo: REPO,
		title: EXTERNAL.title,
		description: EXTERNAL.description,
		beacon: BEACON,
		embedExternal: EXTERNAL,
		kind: "feat",
		createdAt: "2026-07-11T00:00:00.000Z",
	});
	assert.equal(result.outcome, "created");
	assert.match(result.capRef, /^[a-z]+-[a-z]+-[a-z]+$/);
	assert.equal(result.createdAt, "2026-07-11T00:00:00.000Z");
	const written = puts[0].record;
	assert.deepEqual(written.embed.external, EXTERNAL);
	assert.equal(written.beacon, BEACON);
	assert.equal(written.kind, "feat");
	assert.equal(puts[0].swapRecord, undefined);
});

test("publishOrRefreshCap refreshes with CAS and preserves rkey, ref, and createdAt", async () => {
	const records = new Map([["cap1", { cid: "bafold", value: { $type: CAP } }]]);
	const puts = [];
	const agent = capAgent({ records, puts });
	const existing = {
		rkey: "cap1",
		cid: "bafold",
		capRef: "fast-lru-cache",
		createdAt: "2026-07-01T00:00:00.000Z",
	};
	const result = await publishOrRefreshCap(agent, {
		repo: REPO,
		existing,
		title: EXTERNAL.title,
		description: EXTERNAL.description,
		beacon: BEACON,
		embedExternal: EXTERNAL,
		kind: "feat",
		createdAt: "2026-07-11T00:00:00.000Z",
	});
	assert.equal(result.outcome, "refreshed");
	assert.equal(result.rkey, "cap1");
	assert.equal(result.capRef, "fast-lru-cache");
	assert.equal(result.createdAt, "2026-07-01T00:00:00.000Z");
	assert.equal(puts[0].swapRecord, "bafold");

	// A stale swap CID fails without a silent overwrite.
	await assert.rejects(
		publishOrRefreshCap(agent, {
			repo: REPO,
			existing: { ...existing, cid: "stale" },
			title: EXTERNAL.title,
			description: EXTERNAL.description,
			beacon: BEACON,
			embedExternal: EXTERNAL,
			kind: "feat",
			createdAt: "2026-07-11T00:00:00.000Z",
		}),
		(error) => error.code === "cap-cas-conflict" && typeof error.remediation === "string",
	);
});
