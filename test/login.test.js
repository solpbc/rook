// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { login } from "../src/cmd/login.js";
import { writeIdentity } from "../src/lib/identity.js";
import { deriveIdentityPaths } from "../src/lib/paths.js";
import { atomicWriteFile } from "../src/lib/storage.js";
import { temporaryHome, testIdentity } from "./helpers.js";

test("fresh login performs preview and signed manual consent without a listener", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	const identity = await testIdentity();
	await writeIdentity(home.env.ROOK_IDENTITY_FILE, identity);
	const scope = "atproto test:capability";
	const metadata = {
		client_id: "https://rook.invalid/client-metadata.json",
		scope,
		redirect_uris: ["http://127.0.0.1/callback"],
	};
	function MetadataClient() {}
	MetadataClient.fetchMetadata = async () => metadata;
	let signedConsent;
	const fetch = async (url, options = {}) => {
		const pathname = new URL(url).pathname;
		if (pathname === "/oauth/authorize" && !options.headers) {
			return Response.json({
				consent_request: {
					client_id: metadata.client_id,
					scope,
					redirect_uri: metadata.redirect_uris[0],
					login_hint: identity.did,
				},
			});
		}
		if (pathname === "/tos") return new Response("terms");
		if (pathname === "/oauth/authorize") {
			signedConsent = options;
			return new Response(null, {
				status: 302,
				headers: {
					location: "http://127.0.0.1/callback?code=safe&state=safe&iss=https%3A%2F%2Frook.invalid",
				},
			});
		}
		throw new Error("unexpected fetch");
	};
	const session = {
		did: identity.did,
		getTokenInfo: async () => ({
			sub: identity.did,
			scope,
			expired: false,
			expiresAt: new Date("2030-01-01T00:00:00Z"),
		}),
	};
	const result = await login(
		{},
		{
			env: home.env,
			fetch,
			NodeOAuthClient: MetadataClient,
			oauthClientFactory: (_metadata, stores) => ({
				restore: async () => {
					throw new Error("missing");
				},
				authorize: async () => "https://rook.invalid/oauth/authorize?client_id=x&request_uri=y",
				callback: async () => {
					await stores.sessionStore.set(identity.did, { saved: true });
					return { session, state: "safe" };
				},
			}),
			clock: () => 1_700_000_000_000,
			uuid: () => "uuid",
		},
	);
	assert.equal(result.restored, false);
	assert.equal(signedConsent.redirect, "manual");
	assert.match(signedConsent.headers.Authorization, /^DPoP /);
	assert.equal(typeof signedConsent.headers.DPoP, "string");
});

test("failed restore and callback leave prior session bytes unchanged", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	const identity = await testIdentity();
	await writeIdentity(home.env.ROOK_IDENTITY_FILE, identity);
	const paths = deriveIdentityPaths(home.env.ROOK_IDENTITY_FILE);
	const original = Buffer.from(`${JSON.stringify({ [identity.did]: { prior: true } })}\n`);
	await atomicWriteFile(paths.sessionPath, original);
	const scope = "atproto capability:test";
	const metadata = {
		client_id: "https://rook.invalid/client-metadata.json",
		scope,
		redirect_uris: ["http://127.0.0.1/callback"],
	};
	function MetadataClient() {}
	MetadataClient.fetchMetadata = async () => metadata;
	const fetch = async (url, options = {}) => {
		const pathname = new URL(url).pathname;
		if (pathname === "/oauth/authorize" && !options.headers) {
			return Response.json({
				consent_request: {
					client_id: metadata.client_id,
					scope,
					redirect_uri: metadata.redirect_uris[0],
					login_hint: identity.did,
				},
			});
		}
		if (pathname === "/tos") return new Response("terms");
		return new Response(null, {
			status: 302,
			headers: { location: "http://127.0.0.1/callback?code=x&state=y" },
		});
	};
	await assert.rejects(
		login(
			{},
			{
				env: home.env,
				fetch,
				NodeOAuthClient: MetadataClient,
				oauthClientFactory: (_metadata, stores) => ({
					restore: async () => {
						await stores.sessionStore.del(identity.did);
						throw new Error("refresh failed");
					},
					authorize: async () => "https://rook.invalid/oauth/authorize?request_uri=x",
					callback: async () => {
						throw new Error("exchange failed");
					},
				}),
			},
		),
		/OAuth callback failed/,
	);
	assert.deepEqual(await fs.readFile(paths.sessionPath), original);
});

test("scope-insufficient restored refresh is rolled back when fresh login fails", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	const identity = await testIdentity();
	await writeIdentity(home.env.ROOK_IDENTITY_FILE, identity);
	const paths = deriveIdentityPaths(home.env.ROOK_IDENTITY_FILE);
	const original = Buffer.from(`${JSON.stringify({ [identity.did]: { prior: true } })}\n`);
	await atomicWriteFile(paths.sessionPath, original);
	const servedScope = "atproto capability:required";
	const metadata = {
		client_id: "https://rook.invalid/client-metadata.json",
		scope: servedScope,
		redirect_uris: ["http://127.0.0.1/callback"],
	};
	function MetadataClient() {}
	MetadataClient.fetchMetadata = async () => metadata;
	const restoredSession = {
		did: identity.did,
		getTokenInfo: async () => ({
			sub: identity.did,
			scope: "atproto",
			expired: false,
			expiresAt: new Date("2030-01-01T00:00:00Z"),
		}),
	};
	const fetch = async (url, options = {}) => {
		const pathname = new URL(url).pathname;
		if (pathname === "/oauth/authorize" && !options.headers) {
			return Response.json({
				consent_request: {
					client_id: metadata.client_id,
					scope: servedScope,
					redirect_uri: metadata.redirect_uris[0],
					login_hint: identity.did,
				},
			});
		}
		if (pathname === "/tos") return new Response("terms");
		return Response.json({ error: "consent_failed" }, { status: 500 });
	};
	await assert.rejects(
		login(
			{},
			{
				env: home.env,
				fetch,
				NodeOAuthClient: MetadataClient,
				oauthClientFactory: (_metadata, stores) => ({
					restore: async () => {
						await stores.sessionStore.set(identity.did, { rotated: true });
						return restoredSession;
					},
					authorize: async () => "https://rook.invalid/oauth/authorize?request_uri=x",
				}),
			},
		),
		/authorization consent returned HTTP 500/,
	);
	assert.deepEqual(await fs.readFile(paths.sessionPath), original);
});
