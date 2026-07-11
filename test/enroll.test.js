// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { enroll } from "../src/cmd/enroll.js";
import { writeIdentity } from "../src/lib/identity.js";
import { temporaryHome, testIdentity, testKeys } from "./helpers.js";

test("existing valid identity is a byte-preserving zero-network no-op", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	const identity = await testIdentity();
	await writeIdentity(home.env.ROOK_IDENTITY_FILE, identity);
	const before = await fs.readFile(home.env.ROOK_IDENTITY_FILE);
	let calls = 0;
	const result = await enroll(
		{ invite: "https://rook.invalid/roost#secret", handle: "test" },
		{
			env: home.env,
			fetch: async () => {
				calls += 1;
			},
		},
	);
	assert.equal(result.existing, true);
	assert.equal(calls, 0);
	assert.deepEqual(await fs.readFile(home.env.ROOK_IDENTITY_FILE), before);
});

test("malformed existing identity fails closed before network", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	await fs.writeFile(home.env.ROOK_IDENTITY_FILE, "not-json");
	let calls = 0;
	await assert.rejects(
		enroll(
			{ invite: "https://rook.invalid/roost#secret", handle: "test" },
			{
				env: home.env,
				fetch: async () => {
					calls += 1;
				},
			},
		),
		/refusing to overwrite/,
	);
	assert.equal(calls, 0);
});

test("enroll persists only a validated 200 and discards the bearer", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	const keys = await testKeys();
	const fetch = async (url, options) => {
		const pathname = new URL(url).pathname;
		if (pathname.endsWith("welcome.md")) return new Response("GET /tos\nPOST /api/signup");
		if (pathname === "/tos") return new Response("terms");
		const request = JSON.parse(options.body);
		return Response.json({
			did: "did:plc:new",
			handle: "new.rook.host",
			access_token: request.access_token,
			token_type: "DPoP",
		});
	};
	const result = await enroll(
		{ invite: "https://rook.invalid/roost#single-use", handle: "new" },
		{
			env: home.env,
			fetch,
			generateRsa4096: async () => keys,
			clock: () => 1_700_000_000_000,
			uuid: () => "jti",
		},
	);
	assert.equal(result.did, "did:plc:new");
	const saved = JSON.parse(await fs.readFile(home.env.ROOK_IDENTITY_FILE, "utf8"));
	assert.equal(Object.hasOwn(saved, "access_token"), false);
	assert.equal((await fs.stat(home.env.ROOK_IDENTITY_FILE)).mode & 0o777, 0o600);
});

test("InviteInvalid uses truthful non-consumption wording", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	const keys = await testKeys();
	const fetch = async (url) => {
		const pathname = new URL(url).pathname;
		if (pathname.endsWith("welcome.md")) return new Response("GET /tos\nPOST /api/signup");
		if (pathname === "/tos") return new Response("terms");
		return Response.json({ error: "InviteInvalid", message: "spent" }, { status: 403 });
	};
	await assert.rejects(
		enroll(
			{ invite: "https://rook.invalid/roost#single-use", handle: "new" },
			{ env: home.env, fetch, generateRsa4096: async () => keys },
		),
		/invalid or already spent.*does not distinguish.*did not consume/s,
	);
});

test("transport and post-success persistence failures use distinct truthful wording", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	const keys = await testKeys();
	const discoveryThen = (signup) => async (url, options) => {
		const pathname = new URL(url).pathname;
		if (pathname.endsWith("welcome.md")) return new Response("GET /tos\nPOST /api/signup");
		if (pathname === "/tos") return new Response("terms");
		return signup(options);
	};
	await assert.rejects(
		enroll(
			{ invite: "https://rook.invalid/roost#secret", handle: "test" },
			{
				env: home.env,
				generateRsa4096: async () => keys,
				fetch: discoveryThen(async () => {
					throw new Error("connection reset");
				}),
			},
		),
		/outcome is undetermined.*may have been consumed.*Do not retry/s,
	);
	await assert.rejects(
		enroll(
			{ invite: "https://rook.invalid/roost#secret", handle: "test" },
			{
				env: home.env,
				generateRsa4096: async () => keys,
				fetch: discoveryThen(async (options) => {
					const request = JSON.parse(options.body);
					return Response.json({
						did: "did:plc:remote",
						handle: "test.rook.host",
						access_token: request.access_token,
						token_type: "DPoP",
					});
				}),
				writeIdentity: async () => {
					throw new Error("disk full");
				},
			},
		),
		/succeeded remotely.*invite was consumed.*not persisted.*Do not retry/s,
	);
});
