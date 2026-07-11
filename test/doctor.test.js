// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";
import { createProgram } from "../src/cli.js";
import { doctor, doctorOverall } from "../src/cmd/doctor.js";
import { RookError } from "../src/lib/error-format.js";
import { resolveGitCommonDir } from "../src/lib/git.js";
import { writeIdentity } from "../src/lib/identity.js";
import { deriveIdentityPaths } from "../src/lib/paths.js";
import { writeRepoState } from "../src/lib/repo-state.js";
import { atomicWriteFile } from "../src/lib/storage.js";
import { memoryStream, temporaryGitRepository, temporaryHome, testIdentity } from "./helpers.js";

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
			overrides.fetchHandler ??
			(async () => Response.json({ token: "DOCTOR-TOKEN-CANARY-1234567890" })),
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

async function setupConfiguredDoctor(t, overrides = {}) {
	const setup = await setupDoctor(t, overrides);
	const repository = await temporaryGitRepository();
	t.after(repository.cleanup);
	const base = await repository.commit({ message: "base" });
	await repository.run(["remote", "add", "origin", "https://github.com/owner/repo.git"]);
	await repository.run(["update-ref", "refs/remotes/origin/main", base]);
	const tip = await repository.commit({
		message: "outgoing",
		authorEmail: overrides.authorEmail ?? setup.identity.did,
		committerEmail: overrides.committerEmail ?? setup.identity.did,
	});
	const repoDid = "did:plc:y4n6knl55l5bcoazo6qki4iu";
	const rookRemoteUrl = `https://${overrides.stateHost ?? "knot.invalid"}/${repoDid}`;
	if (!overrides.missingRemote) {
		await repository.run(["remote", "add", "rook", overrides.localRemoteUrl ?? rookRemoteUrl]);
	}
	const gitCommonDir = await resolveGitCommonDir(repository.directory, { env: repository.env });
	const state = {
		upstreamUrl: "https://github.com/owner/repo.git",
		upstreamDefaultBranch: "main",
		knotRepoName: "repo",
		knotRepoDid: repoDid,
		rookRemoteUrl,
		...(overrides.pushProof === false
			? {}
			: {
					lastPushedBranch: overrides.pushProofBranch ?? "main",
					lastPushedTip: overrides.staleTip ? "a".repeat(40) : tip,
				}),
	};
	await writeRepoState(gitCommonDir, state);
	setup.dependencies.cwd = repository.directory;
	const calls = { advertisements: 0, lsRemote: 0 };
	const advertisement = overrides.receivePackAdvertisement ?? (async () => ({ ok: true }));
	const remoteRef = overrides.lsRemoteRef ?? (async () => tip);
	setup.dependencies.receivePackAdvertisement = async (...args) => {
		calls.advertisements += 1;
		return advertisement(...args);
	};
	setup.dependencies.lsRemoteRef = async (...args) => {
		calls.lsRemote += 1;
		return remoteRef(...args);
	};
	return { ...setup, repository, tip, gitCommonDir, repoDid, rookRemoteUrl, calls };
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

test("identity/auth-only doctor remains not_checked and names rook push", async (t) => {
	const { dependencies } = await setupDoctor(t);
	const result = await doctor({}, dependencies);
	assert.equal(result.overall.status, "not_checked");
	assert.equal(result.checks.at(-1).name, "repository-push-proof");
	assert.equal(result.checks.at(-1).status, "not_checked");
	assert.equal(result.checks.at(-1).recovery, "run rook push");
	assert.equal(result.checks.filter(({ status }) => status === "ok").length, 8);
	assert.match(
		result.checks.find(({ name }) => name === "session-restore-expiry").detail,
		/expired=unknown/,
	);
	assert.doesNotMatch(JSON.stringify(result), /DOCTOR-TOKEN-CANARY/);
	assert.equal((await runDoctorCommand(dependencies)).exitCode, 1);
});

test("doctor is green only for a configured clone with live remote equality", async (t) => {
	const setup = await setupConfiguredDoctor(t);
	const result = await doctor({}, setup.dependencies);
	assert.equal(result.overall.status, "ok");
	for (const name of [
		"repository-state",
		"rook-remote",
		"branch-provenance",
		"receive-pack-advertisement",
		"repository-push-proof",
	]) {
		assert.equal(result.checks.find((item) => item.name === name).status, "ok");
	}
	assert.equal((await runDoctorCommand(setup.dependencies)).exitCode, 0);
});

test("advertisement access without a current saved push proof is never green", async (t) => {
	const setup = await setupConfiguredDoctor(t, { pushProof: false });
	const result = await doctor({}, setup.dependencies);
	assert.equal(
		result.checks.find(({ name }) => name === "receive-pack-advertisement").status,
		"ok",
	);
	const proof = result.checks.find(({ name }) => name === "repository-push-proof");
	assert.equal(proof.status, "not_checked");
	assert.equal(proof.recovery, "run rook push");
	assert.equal(result.overall.status, "not_checked");
});

test("doctor rejects a stale saved tip and names rook push", async (t) => {
	const setup = await setupConfiguredDoctor(t, { staleTip: true });
	const result = await doctor({}, setup.dependencies);
	const proof = result.checks.find(({ name }) => name === "repository-push-proof");
	assert.equal(proof.status, "fail");
	assert.equal(proof.recovery, "run rook push");
	assert.equal(result.overall.status, "fail");
});

test("doctor binds token-bearing probes to the OAuth-derived knot host", async (t) => {
	const setup = await setupConfiguredDoctor(t, { stateHost: "other.invalid" });
	const result = await doctor({}, setup.dependencies);
	for (const name of ["receive-pack-advertisement", "repository-push-proof"]) {
		const earned = result.checks.find((item) => item.name === name);
		assert.equal(earned.status, "fail");
		assert.match(earned.detail, /different knot/);
	}
	assert.deepEqual(setup.calls, { advertisements: 0, lsRemote: 0 });
	const command = await runDoctorCommand(setup.dependencies);
	assert.doesNotMatch(JSON.stringify(command), /DOCTOR-TOKEN-CANARY/);
});

test("doctor rejects an equivalent SSH rook remote without sending the token", async (t) => {
	const setup = await setupConfiguredDoctor(t, {
		localRemoteUrl: "ssh://git@knot.invalid/did:plc:y4n6knl55l5bcoazo6qki4iu",
	});
	const result = await doctor({}, setup.dependencies);
	assert.equal(result.checks.find(({ name }) => name === "rook-remote").status, "fail");
	assert.notEqual(
		result.checks.find(({ name }) => name === "receive-pack-advertisement").status,
		"ok",
	);
	assert.notEqual(result.checks.find(({ name }) => name === "repository-push-proof").status, "ok");
	assert.deepEqual(setup.calls, { advertisements: 0, lsRemote: 0 });
});

test("doctor reports repository configuration and provenance failures", async (t) => {
	for (const [name, options, checkName] of [
		["provenance", { authorEmail: "wrong@example.invalid" }, "branch-provenance"],
		["missing remote", { missingRemote: true }, "rook-remote"],
	]) {
		await t.test(name, async (t) => {
			const setup = await setupConfiguredDoctor(t, options);
			const result = await doctor({}, setup.dependencies);
			assert.equal(result.checks.find((item) => item.name === checkName).status, "fail");
			assert.notEqual(result.overall.status, "ok");
		});
	}
});

test("doctor distinguishes rejected and unavailable receive-pack advertisements", async (t) => {
	for (const [name, code, status] of [
		["rejected", "receive-pack-rejected", "fail"],
		["unavailable", "receive-pack-unavailable", "degraded"],
	]) {
		await t.test(name, async (t) => {
			const setup = await setupConfiguredDoctor(t, {
				receivePackAdvertisement: async () => {
					throw new RookError(name, { code });
				},
			});
			const result = await doctor({}, setup.dependencies);
			assert.equal(
				result.checks.find(({ name: checkName }) => checkName === "receive-pack-advertisement")
					.status,
				status,
			);
		});
	}
});

test("doctor never accepts a push proof saved for another branch", async (t) => {
	const setup = await setupConfiguredDoctor(t, { pushProofBranch: "extro/other" });
	const result = await doctor({}, setup.dependencies);
	assert.equal(result.checks.find(({ name }) => name === "repository-push-proof").status, "fail");
	assert.notEqual(result.overall.status, "ok");
});

test("doctor classifies live remote-ref proof failures", async (t) => {
	for (const [name, lsRemoteRef, status] of [
		[
			"missing",
			async () => {
				throw new RookError("missing", { code: "remote-ref-missing" });
			},
			"fail",
		],
		["mismatch", async () => "b".repeat(40), "fail"],
		[
			"transient",
			async () => {
				throw new Error("offline");
			},
			"degraded",
		],
	]) {
		await t.test(name, async (t) => {
			const setup = await setupConfiguredDoctor(t, { lsRemoteRef });
			const result = await doctor({}, setup.dependencies);
			assert.equal(
				result.checks.find(({ name: checkName }) => checkName === "repository-push-proof").status,
				status,
			);
		});
	}
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
	const healthy = await setupConfiguredDoctor(t);
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
		{ name: "three", status: "not_checked" },
	]);
	assert.equal(result.status, "fail");
});
