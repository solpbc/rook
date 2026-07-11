// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";
import { mintServiceAuth } from "../src/lib/service-auth.js";

const request = {
	serviceOrigin: "https://rook.invalid",
	aud: "did:web:knot.invalid",
	lxm: "sh.tangled.repo.create",
};

function sessionFor(handler) {
	return { fetchHandler: handler };
}

test("mintServiceAuth returns a nonempty token from the exact timed request", async () => {
	let seen;
	const session = sessionFor(async (url, options) => {
		seen = { url: new URL(url), options };
		return Response.json({ token: "service-token" });
	});
	assert.equal(
		await mintServiceAuth(
			session,
			{ ...request, expSeconds: 300 },
			{ clock: () => 1_700_000_000_000 },
		),
		"service-token",
	);
	assert.equal(seen.url.origin, request.serviceOrigin);
	assert.equal(seen.url.pathname, "/xrpc/com.atproto.server.getServiceAuth");
	assert.equal(seen.url.searchParams.get("aud"), request.aud);
	assert.equal(seen.url.searchParams.get("lxm"), request.lxm);
	assert.equal(seen.url.searchParams.get("exp"), "1700000300");
	assert.ok(seen.options.signal instanceof AbortSignal);
});

for (const [name, response, code, message] of [
	[
		"401",
		Response.json({ error: "AuthRequired" }, { status: 401 }),
		"service-auth-rejected",
		/OAuth session was rejected/,
	],
	[
		"403 InsufficientScope",
		Response.json({ error: "InsufficientScope" }, { status: 403 }),
		"service-auth-rejected",
		/scope is insufficient/,
	],
	[
		"5xx",
		Response.json({ error: "InternalError" }, { status: 503 }),
		"service-auth-unavailable",
		/could not mint/,
	],
	[
		"missing token",
		Response.json({}, { status: 200 }),
		"service-auth-unavailable",
		/could not mint/,
	],
	[
		"empty token",
		Response.json({ token: "" }, { status: 200 }),
		"service-auth-unavailable",
		/could not mint/,
	],
]) {
	test(`mintServiceAuth classifies ${name}`, async () => {
		await assert.rejects(
			mintServiceAuth(
				sessionFor(async () => response),
				request,
			),
			(error) => error.code === code && message.test(error.message),
		);
	});
}

test("mintServiceAuth rejects malformed JSON as unavailable", async () => {
	await assert.rejects(
		mintServiceAuth(
			sessionFor(async () => new Response("not-json")),
			request,
		),
		(error) => error.code === "service-auth-unavailable",
	);
});

test("mintServiceAuth rejects network failures as unavailable", async () => {
	await assert.rejects(
		mintServiceAuth(
			sessionFor(async () => {
				throw new Error("offline");
			}),
			request,
		),
		(error) => error.code === "service-auth-unavailable",
	);
});
