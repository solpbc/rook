// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { writeRepoState } from "../src/lib/repo-state.js";
import {
	createKnotRepo,
	createRepoRecord,
	deriveKnotRepoName,
	deriveRepoUrl,
	readRepoRecord,
	receivePackAdvertisement,
	repoRecordMatches,
	validateKnotRepoName,
} from "../src/lib/tangled.js";
import { temporaryHome } from "./helpers.js";

const repoDid = "did:plc:y4n6knl55l5bcoazo6qki4iu";
const repoUrl = `https://knot.rook.host/${repoDid}`;
const createInput = {
	token: "knot-token",
	rkey: "vmlx-swift",
	name: "vmlx-swift",
	defaultBranch: "main",
	source: "https://github.com/osaurus-ai/vmlx-swift.git",
};

test("knot repository names derive byte-for-byte and reject invalid names", () => {
	assert.equal(deriveKnotRepoName("github.com/osaurus-ai/vmlx-swift"), "vmlx-swift");
	assert.equal(validateKnotRepoName("Repo_name.1"), "Repo_name.1");
	for (const identity of [
		"github.com/owner/.hidden",
		"github.com/owner/two..dots",
		"github.com/owner/self",
		"github.com/owner/space name",
	]) {
		assert.throws(
			() => deriveKnotRepoName(identity),
			(error) => error.code === "upstream-url-invalid",
		);
	}
});

test("deriveRepoUrl matches repository-state canonical validation", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	assert.equal(deriveRepoUrl("KNOT.ROOK.HOST", repoDid), repoUrl);
	const state = await writeRepoState(path.join(home.directory, ".git"), {
		upstreamUrl: createInput.source,
		upstreamDefaultBranch: "main",
		knotRepoName: createInput.name,
		knotRepoDid: repoDid,
		rookRemoteUrl: deriveRepoUrl("KNOT.ROOK.HOST", repoDid),
	});
	assert.equal(state.rookRemoteUrl, repoUrl);
	assert.throws(() => deriveRepoUrl("knot.rook.host/path", repoDid), /host is invalid/);
	assert.throws(() => deriveRepoUrl("knot.rook.host", "not-a-did"), /DID is invalid/);
});

test("createKnotRepo sends the live-proven body and accepts a minted repo DID", async () => {
	let request;
	const fetch = async (url, options) => {
		request = { url: new URL(url), options };
		return Response.json({ repoDid });
	};
	assert.deepEqual(
		await createKnotRepo({ origin: "https://knot.rook.host" }, createInput, { fetch }),
		{ repoDid },
	);
	assert.equal(request.url.pathname, "/xrpc/sh.tangled.repo.create");
	assert.equal(request.options.method, "POST");
	assert.equal(request.options.headers.Authorization, "Bearer knot-token");
	assert.deepEqual(JSON.parse(request.options.body), {
		rkey: "vmlx-swift",
		name: "vmlx-swift",
		defaultBranch: "main",
		source: "https://github.com/osaurus-ai/vmlx-swift.git",
	});
	assert.equal(Object.hasOwn(JSON.parse(request.options.body), "repoDid"), false);
});

for (const [name, response, code] of [
	["409 conflict", new Response(null, { status: 409 }), "repo-create-conflict"],
	["other 4xx", new Response(null, { status: 400 }), "repo-create-rejected"],
	["5xx", new Response(null, { status: 503 }), "repo-create-rejected"],
	["malformed JSON", new Response("not-json"), "repo-create-invalid-response"],
	["missing repo DID", Response.json({}), "repo-create-invalid-response"],
]) {
	test(`createKnotRepo fails closed on ${name}`, async () => {
		await assert.rejects(
			createKnotRepo({ origin: "https://knot.rook.host" }, createInput, {
				fetch: async () => response,
			}),
			(error) => error.code === code,
		);
	});
}

test("createKnotRepo rejects network failures without exposing response data", async () => {
	await assert.rejects(
		createKnotRepo({ origin: "https://knot.rook.host" }, createInput, {
			fetch: async () => {
				throw new Error("offline secret");
			},
		}),
		(error) => error.code === "repo-create-rejected" && !error.message.includes("secret"),
	);
});

test("readRepoRecord returns a found value and sends exact query parameters", async () => {
	const value = { $type: "sh.tangled.repo", repoDid };
	let request;
	const session = {
		fetchHandler: async (url, options) => {
			request = { url: new URL(url, "https://pds.invalid"), options };
			return Response.json({ uri: "at://did:plc:rook/sh.tangled.repo/vmlx-swift", value });
		},
	};
	assert.deepEqual(
		await readRepoRecord(session, { repo: "did:plc:rook", rkey: "vmlx-swift" }),
		value,
	);
	assert.equal(request.url.pathname, "/xrpc/com.atproto.repo.getRecord");
	assert.deepEqual(Object.fromEntries(request.url.searchParams), {
		repo: "did:plc:rook",
		collection: "sh.tangled.repo",
		rkey: "vmlx-swift",
	});
	assert.ok(request.options.signal instanceof AbortSignal);
});

test("readRepoRecord requires an exact returned AT URI", async () => {
	const value = { $type: "sh.tangled.repo", repoDid };
	for (const uri of [
		undefined,
		"at://did:plc:other/sh.tangled.repo/vmlx-swift",
		"at://did:plc:rook/sh.tangled.repo/other",
		"at://did:plc:rook/sh.tangled.repo/vmlx-swift-lookalike",
	]) {
		await assert.rejects(
			readRepoRecord(
				{ fetchHandler: async () => Response.json({ uri, value }) },
				{ repo: "did:plc:rook", rkey: "vmlx-swift" },
			),
			(error) => error.code === "repo-record-invalid-response",
		);
	}
});

test("readRepoRecord recognizes only the protocol RecordNotFound response", async () => {
	const missing = {
		fetchHandler: async () => Response.json({ error: "RecordNotFound" }, { status: 400 }),
	};
	assert.equal(
		await readRepoRecord(missing, { repo: "did:plc:rook", rkey: "vmlx-swift" }),
		undefined,
	);
	for (const response of [
		Response.json({ error: "RecordNotFound" }, { status: 401 }),
		Response.json({ error: "OtherError" }, { status: 400 }),
	]) {
		await assert.rejects(
			readRepoRecord(
				{ fetchHandler: async () => response },
				{ repo: "did:plc:rook", rkey: "vmlx-swift" },
			),
			(error) => error.code === "repo-record-rejected",
		);
	}
	await assert.rejects(
		readRepoRecord(
			{
				fetchHandler: async () => {
					throw new Error("offline secret");
				},
			},
			{ repo: "did:plc:rook", rkey: "vmlx-swift" },
		),
		(error) => error.code === "repo-record-rejected" && !error.message.includes("secret"),
	);
});

test("createRepoRecord sends the exact record and requires an exact returned AT URI", async () => {
	const record = {
		$type: "sh.tangled.repo",
		knot: "knot.rook.host",
		createdAt: "2023-11-14T22:13:20.000Z",
		repoDid,
		source: createInput.source,
		name: createInput.name,
	};
	let request;
	const session = {
		fetchHandler: async (url, options) => {
			request = { url, options };
			return Response.json({ uri: "at://did:plc:rook/sh.tangled.repo/vmlx-swift" });
		},
	};
	assert.deepEqual(
		await createRepoRecord(session, { repo: "did:plc:rook", rkey: "vmlx-swift", record }),
		{ uri: "at://did:plc:rook/sh.tangled.repo/vmlx-swift" },
	);
	assert.equal(request.url, "/xrpc/com.atproto.repo.createRecord");
	assert.deepEqual(JSON.parse(request.options.body), {
		repo: "did:plc:rook",
		collection: "sh.tangled.repo",
		rkey: "vmlx-swift",
		record,
	});
	assert.equal(repoRecordMatches(record, record), true);
	assert.equal(
		repoRecordMatches({ ...record, source: "ssh://git@github.com/osaurus-ai/vmlx-swift" }, record),
		true,
	);
	assert.equal(repoRecordMatches({ ...record, repoDid: "did:plc:other" }, record), false);

	await assert.rejects(
		createRepoRecord(
			{
				fetchHandler: async () =>
					Response.json({ uri: "at://did:plc:rook/sh.tangled.repo/vmlx-swift-lookalike" }),
			},
			{ repo: "did:plc:rook", rkey: "vmlx-swift", record },
		),
		(error) => error.code === "repo-record-invalid-response",
	);
	await assert.rejects(
		createRepoRecord(
			{ fetchHandler: async () => new Response(null, { status: 401 }) },
			{ repo: "did:plc:rook", rkey: "vmlx-swift", record },
		),
		(error) => error.code === "repo-record-rejected",
	);
});

test("receivePackAdvertisement accepts the proven media type with parameters", async () => {
	let request;
	const fetch = async (url, options) => {
		request = { url: new URL(url), options };
		return new Response("advertisement", {
			headers: {
				"content-type": "application/x-git-receive-pack-advertisement; charset=binary",
			},
		});
	};
	assert.deepEqual(await receivePackAdvertisement(repoUrl, { token: "receive-token" }, { fetch }), {
		ok: true,
	});
	assert.equal(request.url.pathname, `/${repoDid}/info/refs`);
	assert.equal(request.url.searchParams.get("service"), "git-receive-pack");
	assert.equal(request.options.headers.Authorization, "Bearer receive-token");
});

for (const [name, response, code] of [
	[
		"wrong media type",
		new Response("body", { headers: { "content-type": "text/plain" } }),
		"receive-pack-rejected",
	],
	["401", new Response(null, { status: 401 }), "receive-pack-rejected"],
	["5xx", new Response(null, { status: 503 }), "receive-pack-unavailable"],
]) {
	test(`receivePackAdvertisement classifies ${name}`, async () => {
		await assert.rejects(
			receivePackAdvertisement(
				repoUrl,
				{ token: "receive-token" },
				{
					fetch: async () => response,
				},
			),
			(error) => error.code === code,
		);
	});
}

test("receivePackAdvertisement classifies a network failure as unavailable", async () => {
	await assert.rejects(
		receivePackAdvertisement(
			repoUrl,
			{ token: "receive-token" },
			{
				fetch: async () => {
					throw new Error("offline");
				},
			},
		),
		(error) => error.code === "receive-pack-unavailable",
	);
});
