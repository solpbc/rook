// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";
import { createProgram } from "../src/cli.js";
import { doctor, doctorOverall } from "../src/cmd/doctor.js";
import { writeIdentity } from "../src/lib/identity.js";
import { deriveIdentityPaths } from "../src/lib/paths.js";
import { atomicWriteFile } from "../src/lib/storage.js";
import { memoryStream, temporaryHome, testIdentity } from "./helpers.js";

async function setupDoctor(t, overrides = {}) {
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
			expired: overrides.expired,
			expiresAt: overrides.expiresAt,
		}),
		fetchHandler:
			overrides.fetchHandler ?? (async () => Response.json({ token: "service-auth-secret" })),
	};
	const dependencies = {
		env: home.env,
		NodeOAuthClient: MetadataClient,
		oauthClientFactory: () => ({ restore: async () => session }),
		verifyHandleDid: overrides.verifyHandleDid ?? (async () => true),
		listKnotMembers: overrides.listKnotMembers ?? (async () => new Set([identity.did])),
		clock: () => 1_700_000_000_000,
		...(overrides.dependencies ?? {}),
	};
	return { dependencies, identity, metadata, scope };
}

async function runDoctorCommand(dependencies) {
	const stdout = memoryStream();
	const stderr = memoryStream();
	const program = createProgram({ ...dependencies, stdout, stderr });
	process.exitCode = 0;
	await program.parseAsync(["node", "rook", "doctor", "--json"]);
	const exitCode = process.exitCode;
	process.exitCode = 0;
	return { exitCode, result: JSON.parse(stdout.toString()), stderr: stderr.toString() };
}

test("doctor earns all identity/auth checks and reports unknown session expiry truthfully", async (t) => {
	const { dependencies } = await setupDoctor(t);
	const result = await doctor({}, dependencies);
	assert.equal(result.overall.status, "not_checked");
	assert.equal(result.checks.at(-1).name, "repository-push");
	assert.equal(result.checks.at(-1).status, "not_checked");
	assert.equal(result.checks.at(-1).detail, "repository push has not been checked yet");
	assert.equal(result.checks.filter(({ status }) => status === "ok").length, 8);
	assert.match(
		result.checks.find(({ name }) => name === "session-restore-expiry").detail,
		/expired=unknown/,
	);
	assert.doesNotMatch(JSON.stringify(result), /service-auth-secret/);
});

test("doctor maps 403 InsufficientScope to failed service-auth checks naming scopes", async (t) => {
	const { dependencies } = await setupDoctor(t, {
		fetchHandler: async () =>
			Response.json({ error: "InsufficientScope", message: "missing" }, { status: 403 }),
	});
	const result = await doctor({}, dependencies);
	for (const name of ["service-auth-repo-create", "service-auth-receive-pack"]) {
		const earned = result.checks.find((item) => item.name === name);
		assert.equal(earned.status, "fail");
		assert.match(earned.detail, /missing required scope rpc:/);
		assert.doesNotMatch(earned.detail, /expir/i);
	}
	const stdout = memoryStream();
	const stderr = memoryStream();
	const program = createProgram({ ...dependencies, stdout, stderr });
	process.exitCode = 0;
	await program.parseAsync(["node", "rook", "doctor"]);
	assert.equal(process.exitCode, 1);
	assert.match(stdout.toString(), /recovery: run rook login/);
	process.exitCode = 0;
});

test("doctor degrades malformed knot pages and fails exhaustive DID absence", async (t) => {
	const malformed = await setupDoctor(t, {
		dependencies: { fetch: async () => new Response("not-json") },
	});
	malformed.dependencies.listKnotMembers = undefined;
	const malformedResult = await doctor({}, malformed.dependencies);
	assert.deepEqual(
		malformedResult.checks.find(({ name }) => name === "knot-membership"),
		{
			name: "knot-membership",
			status: "degraded",
			detail: "could not verify membership",
		},
	);
	const absent = await setupDoctor(t, { listKnotMembers: async () => new Set() });
	const absentResult = await doctor({}, absent.dependencies);
	assert.equal(absentResult.checks.find(({ name }) => name === "knot-membership").status, "fail");
});

test("doctor command exits 0 only for earned checks and 1 for degraded or failed checks", async (t) => {
	const healthy = await setupDoctor(t);
	assert.equal((await runDoctorCommand(healthy.dependencies)).exitCode, 0);
	const degraded = await setupDoctor(t, {
		verifyHandleDid: async () => {
			throw new Error("offline");
		},
	});
	assert.equal((await runDoctorCommand(degraded.dependencies)).exitCode, 1);
	const failed = await setupDoctor(t, { verifyHandleDid: async () => false });
	assert.equal((await runDoctorCommand(failed.dependencies)).exitCode, 1);
});

test("doctor status ranks fail above degraded and unchecked", () => {
	const result = doctorOverall([
		{ name: "one", status: "degraded" },
		{ name: "two", status: "fail" },
		{ name: "repository-push", status: "not_checked" },
	]);
	assert.equal(result.status, "fail");
});
