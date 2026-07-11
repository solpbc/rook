// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";
import { resolvePdsEndpoint } from "../src/lib/pds.js";

const DID = "did:plc:requester0000000000000";
const PLC_URL = `https://plc.directory/${encodeURIComponent(DID)}`;
const PDS_ORIGIN = "https://pds.author.example";

function didDocument(overrides = {}) {
	return {
		service: [
			{
				id: "#atproto_pds",
				type: "AtprotoPersonalDataServer",
				serviceEndpoint: PDS_ORIGIN,
				...overrides,
			},
		],
	};
}

function assertUnresolved(error) {
	assert.equal(error.code, "pds-unresolved");
	assert.equal(error.message, "PDS endpoint could not be resolved");
	assert.equal(error.cause, undefined);
	assert.doesNotMatch(error.message, /secret/i);
	return true;
}

test("resolvePdsEndpoint returns the normalized PDS origin", async () => {
	let request;
	const endpoint = await resolvePdsEndpoint(DID, {
		fetch: async (input, init) => {
			request = { url: input.toString(), init };
			return Response.json(didDocument({ serviceEndpoint: `${PDS_ORIGIN}/xrpc?ignored=1` }));
		},
	});
	assert.equal(endpoint, PDS_ORIGIN);
	assert.equal(request.url, PLC_URL);
	assert.ok(request.init.signal instanceof AbortSignal);
});

test("resolvePdsEndpoint accepts a fully-qualified PDS service id", async () => {
	const endpoint = await resolvePdsEndpoint(DID, {
		fetch: async () => Response.json(didDocument({ id: `${DID}#atproto_pds` })),
	});
	assert.equal(endpoint, PDS_ORIGIN);
});

test("resolvePdsEndpoint rejects unsupported and malformed DIDs before fetch", async () => {
	for (const did of [
		"did:web:example.com",
		"did:plc:",
		"did:plc:bad/value",
		"not-a-did",
		undefined,
	]) {
		let fetched = false;
		await assert.rejects(
			resolvePdsEndpoint(did, {
				fetch: async () => {
					fetched = true;
					return Response.json(didDocument());
				},
			}),
			assertUnresolved,
		);
		assert.equal(fetched, false);
	}
});

test("resolvePdsEndpoint rejects plc.directory and document failures without leaks", async () => {
	for (const fetchImpl of [
		async () => {
			throw new Error("upstream secret");
		},
		async () => Response.json({ error: "response secret" }, { status: 503 }),
		async () => new Response("malformed secret", { status: 200 }),
	]) {
		await assert.rejects(resolvePdsEndpoint(DID, { fetch: fetchImpl }), assertUnresolved);
	}
});

test("resolvePdsEndpoint requires the AT Protocol PDS service entry", async () => {
	for (const document of [
		{},
		{ service: {} },
		{ service: [] },
		didDocument({ id: "#other" }),
		didDocument({ type: "OtherService" }),
		didDocument({ serviceEndpoint: undefined }),
		didDocument({ serviceEndpoint: "" }),
	]) {
		await assert.rejects(
			resolvePdsEndpoint(DID, { fetch: async () => Response.json(document) }),
			assertUnresolved,
		);
	}
});

test("resolvePdsEndpoint rejects unsafe PDS service endpoints", async () => {
	for (const serviceEndpoint of [
		"http://pds.author.example",
		"https://user@pds.author.example",
		"https://user:password@pds.author.example",
		"not a URL",
		"https://",
	]) {
		await assert.rejects(
			resolvePdsEndpoint(DID, {
				fetch: async () => Response.json(didDocument({ serviceEndpoint })),
			}),
			assertUnresolved,
		);
	}
});
