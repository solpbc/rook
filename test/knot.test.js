// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";
import { listKnotMembers } from "../src/lib/knot.js";

const target = {
	origin: "https://knot.invalid",
	subject: "knot.invalid",
};

test("knot membership exhaustively follows cursors and unions member DIDs", async () => {
	const seen = [];
	const fetch = async (url) => {
		const cursor = new URL(url).searchParams.get("cursor");
		seen.push(cursor);
		return cursor === null
			? Response.json({ items: [{ subject: "did:plc:first" }], cursor: "next" })
			: Response.json({ items: [{ subject: "did:plc:present" }] });
	};
	const members = await listKnotMembers(target, { fetch });
	assert.deepEqual(seen, [null, "next"]);
	assert.equal(members.has("did:plc:present"), true);
	assert.equal(members.has("did:plc:absent"), false);
});

test("knot membership rejects a cursor cycle", async () => {
	const fetch = async () => Response.json({ items: [], cursor: "same" });
	await assert.rejects(listKnotMembers(target, { fetch }), /could not verify membership/);
});

test("knot membership rejects oversized content before reading the body", async () => {
	let bodyRead = false;
	const fetch = async () => ({
		ok: true,
		headers: new Headers({ "content-length": "101" }),
		text: async () => {
			bodyRead = true;
			return "{}";
		},
	});
	await assert.rejects(
		listKnotMembers(target, { fetch, maxResponseBytes: 100 }),
		/could not verify membership/,
	);
	assert.equal(bodyRead, false);
});

test("knot membership enforces an overall deadline", async () => {
	let now = 0;
	const fetch = async () => {
		now += 20;
		return Response.json({ items: [], cursor: String(now) });
	};
	await assert.rejects(
		listKnotMembers(target, { fetch, clock: () => now, overallTimeoutMs: 10 }),
		/could not verify membership/,
	);
});
