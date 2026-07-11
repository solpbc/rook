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
const REQUESTER = "did:plc:requester0000000000000";
const CAP = "org.v-it.cap";
const PDS_ORIGIN = "https://pds.author.example";
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
				},
			},
		},
	};
}

function requestFetch(getRecord, requests = []) {
	return async (input, init = {}) => {
		const url = new URL(input);
		if (url.origin === "https://plc.directory") {
			assert.equal(url.pathname, `/${encodeURIComponent(REQUESTER)}`);
			return Response.json({
				service: [
					{
						id: "#atproto_pds",
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: PDS_ORIGIN,
					},
				],
			});
		}
		if (url.origin === PDS_ORIGIN && url.pathname === "/xrpc/com.atproto.repo.getRecord") {
			requests.push({ url, init });
			return getRecord(url, init);
		}
		throw new Error(`unexpected request to ${url.origin}`);
	};
}

function assertRequestUnresolved(error) {
	assert.equal(error.code, "request-cap-unresolved");
	assert.equal(error.cause, undefined);
	assert.doesNotMatch(error.message, /secret/i);
	return true;
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
	// A request reply cap is not matched by a non-request ship, so it is never
	// reparented into a plain cap.
	assert.equal(capMatches(reply, { renderedPullUrl: RENDERED, beacon: BEACON }), false);
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
	const rootRef = { uri: `at://${REQUESTER}/${CAP}/root`, cid: "bafroot" };
	const records = new Map([
		["threaded", { cid: "bafparent1", value: { $type: CAP, reply: { root: rootRef } } }],
		["standalone", { cid: "bafparent2", value: { $type: CAP } }],
	]);
	const requests = [];
	const fetch = requestFetch((url) => {
		const rkey = url.searchParams.get("rkey");
		const entry = records.get(rkey);
		return Response.json({
			uri: `at://${REQUESTER}/${CAP}/${rkey}`,
			cid: entry.cid,
			value: entry.value,
		});
	}, requests);

	const threaded = await resolveRequestCap(`at://${REQUESTER}/${CAP}/threaded`, { fetch });
	assert.deepEqual(threaded.parent, {
		uri: `at://${REQUESTER}/${CAP}/threaded`,
		cid: "bafparent1",
	});
	assert.deepEqual(threaded.root, rootRef);

	const standalone = await resolveRequestCap(`at://${REQUESTER}/${CAP}/standalone`, { fetch });
	assert.deepEqual(standalone.parent, standalone.root);

	assert.equal(requests.length, 2);
	for (const request of requests) {
		assert.equal(request.url.origin, PDS_ORIGIN);
		assert.equal(request.url.pathname, "/xrpc/com.atproto.repo.getRecord");
		assert.equal(request.url.searchParams.get("repo"), REQUESTER);
		assert.equal(request.url.searchParams.get("collection"), CAP);
		assert.ok(["threaded", "standalone"].includes(request.url.searchParams.get("rkey")));
		assert.equal(new Headers(request.init.headers).has("authorization"), false);
		assert.ok(request.init.signal instanceof AbortSignal);
	}
});

test("resolveRequestCap rejects invalid URIs before fetch", async () => {
	let fetched = false;
	await assert.rejects(
		resolveRequestCap("not-an-at-uri", {
			fetch: async () => {
				fetched = true;
			},
		}),
		assertRequestUnresolved,
	);
	assert.equal(fetched, false);
});

test("resolveRequestCap rejects non-cap records", async () => {
	const requestUri = `at://${REQUESTER}/${CAP}/x`;
	const fetch = requestFetch(async () =>
		Response.json({
			uri: requestUri,
			cid: "bafx",
			value: { $type: "sh.tangled.repo.pull" },
		}),
	);
	await assert.rejects(resolveRequestCap(requestUri, { fetch }), assertRequestUnresolved);
});

test("resolveRequestCap fails closed for public record transport failures", async () => {
	const requestUri = `at://${REQUESTER}/${CAP}/missing`;
	for (const getRecord of [
		async () => Response.json({ error: "RecordNotFound", message: "body secret" }, { status: 400 }),
		async () =>
			Response.json({ error: "UpstreamFailure", message: "body secret" }, { status: 503 }),
		async () => {
			throw new Error("transport secret");
		},
		async () => new Response("malformed secret", { status: 200 }),
	]) {
		await assert.rejects(
			resolveRequestCap(requestUri, { fetch: requestFetch(getRecord) }),
			assertRequestUnresolved,
		);
	}
});

test("resolveRequestCap fails closed for invalid public record responses", async () => {
	const requestUri = `at://${REQUESTER}/${CAP}/x`;
	for (const body of [
		null,
		{ uri: requestUri, cid: "bafcid", value: null },
		{ uri: `at://${REQUESTER}/${CAP}/other`, cid: "bafcid", value: { $type: CAP } },
		{ uri: requestUri, value: { $type: CAP } },
		{ uri: requestUri, cid: "", value: { $type: CAP } },
		{ uri: requestUri, cid: "bafcid", value: { $type: "body secret" } },
	]) {
		await assert.rejects(
			resolveRequestCap(requestUri, {
				fetch: requestFetch(async () => Response.json(body)),
			}),
			assertRequestUnresolved,
		);
	}
});

test("resolveRequestCap translates PDS resolution failures without leaks", async () => {
	const requestUri = `at://${REQUESTER}/${CAP}/x`;
	await assert.rejects(
		resolveRequestCap(requestUri, {
			fetch: async () => Response.json({ error: "plc secret" }, { status: 503 }),
		}),
		assertRequestUnresolved,
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
