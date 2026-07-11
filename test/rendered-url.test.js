// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";
import { resolveRenderedPullUrl } from "../src/lib/rendered-url.js";

const OWNER = "did:plc:testrook";
const REPO = "widget";
const BASE = `https://tangled.org/${OWNER}/${REPO}/pulls`;
const MINE = "at://did:plc:testrook/sh.tangled.repo.pull/mine";

function fakeFetch(pages) {
	const calls = [];
	return {
		calls,
		fetch: async (url) => {
			const key = String(url);
			calls.push(key);
			const body = pages[key];
			if (body === undefined) return { ok: false, status: 404, text: async () => "" };
			return { ok: true, status: 200, text: async () => body };
		},
	};
}

const staticClock = () => 1_700_000_000_000;
const noSleep = async () => {};

test("resolves by exact AT-URI, checking newest candidates first and skipping non-matches", async () => {
	const pages = {
		[BASE]: `<a href="/${OWNER}/${REPO}/pulls/6"></a><a href="/${OWNER}/${REPO}/pulls/5"></a>`,
		[`${BASE}/6`]: `<article data-aturi="at://did:plc:other/sh.tangled.repo.pull/zzz"></article>`,
		[`${BASE}/5`]: `<article data-aturi="${MINE}"></article>`,
	};
	const net = fakeFetch(pages);
	const url = await resolveRenderedPullUrl(
		MINE,
		{ owner: OWNER, repoSlug: REPO },
		{ fetch: net.fetch, clock: staticClock, sleep: noSleep, renderedUrlMaxRounds: 2 },
	);
	assert.equal(url, `${BASE}/5`);
	// list, then candidate 6 (newest) before candidate 5 (ours).
	assert.equal(net.calls[0], BASE);
	assert.ok(net.calls[1].endsWith("/6"));
	assert.ok(net.calls[2].endsWith("/5"));
});

test("fails with rendered-url-unresolved when the pull never indexes", async () => {
	const pages = {
		[BASE]: `<a href="/${OWNER}/${REPO}/pulls/9"></a>`,
		[`${BASE}/9`]: `<article data-aturi="at://did:plc:other/sh.tangled.repo.pull/zzz"></article>`,
	};
	const net = fakeFetch(pages);
	await assert.rejects(
		resolveRenderedPullUrl(
			MINE,
			{ owner: OWNER, repoSlug: REPO },
			{ fetch: net.fetch, clock: staticClock, sleep: noSleep, renderedUrlMaxRounds: 2 },
		),
		(error) => error.code === "rendered-url-unresolved" && typeof error.remediation === "string",
	);
});
