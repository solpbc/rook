// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";
import { doctor, doctorOverall } from "../src/cmd/doctor.js";
import { writeIdentity } from "../src/lib/identity.js";
import { deriveIdentityPaths } from "../src/lib/paths.js";
import { atomicWriteFile } from "../src/lib/storage.js";
import { temporaryHome, testIdentity } from "./helpers.js";

test("doctor earns all identity/auth checks and retains repository caveat", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	const identity = await testIdentity();
	await writeIdentity(home.env.ROOK_IDENTITY_FILE, identity);
	const paths = deriveIdentityPaths(home.env.ROOK_IDENTITY_FILE);
	await atomicWriteFile(
		paths.sessionPath,
		`${JSON.stringify({ [identity.did]: { saved: true } })}\n`,
	);
	const audience = "did:web:knot.invalid";
	const scope = [
		"atproto",
		`rpc:sh.tangled.repo.create?aud=${audience}`,
		`rpc:sh.tangled.git.receivePack?aud=${audience}`,
	].join(" ");
	const metadata = {
		client_id: "https://rook.invalid/client-metadata.json",
		scope,
		redirect_uris: ["http://127.0.0.1/callback"],
	};
	function MetadataClient() {}
	MetadataClient.fetchMetadata = async () => metadata;
	const session = {
		did: identity.did,
		getTokenInfo: async () => ({
			sub: identity.did,
			scope,
			expired: false,
			expiresAt: new Date("2030-01-01T00:00:00Z"),
		}),
		fetchHandler: async () => Response.json({ token: "service-auth-secret" }),
	};
	const result = await doctor(
		{},
		{
			env: home.env,
			NodeOAuthClient: MetadataClient,
			oauthClientFactory: () => ({ restore: async () => session }),
			verifyHandleDid: async () => true,
			listKnotMembers: async () => new Set([identity.did]),
			clock: () => 1_700_000_000_000,
		},
	);
	assert.equal(result.overall.status, "not_checked");
	assert.equal(result.checks.at(-1).name, "repository-push");
	assert.equal(result.checks.at(-1).status, "not_checked");
	assert.equal(result.checks.filter(({ status }) => status === "ok").length, 8);
	assert.doesNotMatch(JSON.stringify(result), /service-auth-secret/);
});

test("doctor status ranks fail above degraded and unchecked", () => {
	const result = doctorOverall([
		{ name: "one", status: "degraded" },
		{ name: "two", status: "fail" },
		{ name: "repository-push", status: "not_checked" },
	]);
	assert.equal(result.status, "fail");
});
