// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createProgram } from "../src/cli.js";
import { fork } from "../src/cmd/fork.js";
import { RookError } from "../src/lib/error-format.js";
import { getRemoteUrl, resolveGitCommonDir } from "../src/lib/git.js";
import { deriveIdentityPaths } from "../src/lib/paths.js";
import { readRepoState, repoStatePath, writeRepoState } from "../src/lib/repo-state.js";
import { atomicWriteFile } from "../src/lib/storage.js";
import { memoryStream, temporaryGitRepository } from "./helpers.js";

const ORIGIN_URL = "https://github.com/owner/repo";
const UPSTREAM_URL = "git@github.com:owner/repo.git";
const SOURCE_URL = "https://github.com/owner/repo.git";
const REPO_DID = "did:plc:y4n6knl55l5bcoazo6qki4iu";
const ROOK_URL = `https://knot.rook.host/${REPO_DID}`;

async function setupFork(t, options = {}) {
	const repository = await temporaryGitRepository();
	t.after(repository.cleanup);
	if (options.commit !== false) await repository.commit({ message: "base" });
	await repository.run(["remote", "add", "origin", options.originUrl ?? ORIGIN_URL]);
	if (options.commit !== false) {
		if (options.remoteRef !== false) {
			await repository.run(["update-ref", "refs/remotes/origin/main", "HEAD"]);
		}
		if (options.remoteHead !== false) {
			await repository.run([
				"symbolic-ref",
				"refs/remotes/origin/HEAD",
				"refs/remotes/origin/main",
			]);
		}
	}

	const identityPath = path.join(repository.root, "identity.json");
	const paths = deriveIdentityPaths(identityPath);
	await atomicWriteFile(paths.sessionPath, "{}\n");
	const identity = {
		did: "did:plc:testrook",
		handle: "test.rook.invalid",
		serviceOrigin: "https://rook.invalid",
	};
	const aud = "did:web:knot.rook.host";
	const scope = ["atproto", "repo:sh.tangled.repo", `rpc:sh.tangled.repo.create?aud=${aud}`].join(
		" ",
	);
	const metadata = { scope };
	const records = new Map();
	const calls = {
		knotCreates: 0,
		recordCreates: 0,
		recordReads: 0,
		mints: 0,
		promotes: 0,
		rollbacks: 0,
		lastCreateBody: undefined,
	};
	const session = {
		did: identity.did,
		fetchHandler: async (input, init = {}) => {
			const url = new URL(input, identity.serviceOrigin);
			if (url.pathname === "/xrpc/com.atproto.server.getServiceAuth") {
				calls.mints += 1;
				return Response.json({ token: "SERVICE-TOKEN-CANARY" });
			}
			if (url.pathname === "/xrpc/com.atproto.repo.getRecord") {
				calls.recordReads += 1;
				const record = records.get(url.searchParams.get("rkey"));
				return record
					? Response.json({
							uri: `at://${identity.did}/sh.tangled.repo/${url.searchParams.get("rkey")}`,
							value: record,
						})
					: Response.json({ error: "RecordNotFound" }, { status: 400 });
			}
			if (url.pathname === "/xrpc/com.atproto.repo.createRecord") {
				const body = JSON.parse(init.body);
				calls.lastCreateBody = body;
				if (records.has(body.rkey)) {
					return Response.json({ error: "RecordAlreadyExists" }, { status: 400 });
				}
				calls.recordCreates += 1;
				records.set(body.rkey, body.record);
				return Response.json({
					uri: options.createRecordUri ?? `at://${body.repo}/sh.tangled.repo/${body.rkey}`,
				});
			}
			throw new Error("unexpected session request");
		},
	};
	const dependencies = {
		cwd: repository.directory,
		env: { ...repository.env, ROOK_IDENTITY_FILE: identityPath },
		clock: () => 1_700_000_000_000,
		readIdentity: async () => identity,
		fetchClientMetadata: async () => metadata,
		restoreSession: async () => ({
			session,
			info: { sub: identity.did, scope, expired: false },
			transaction: {
				promote: async () => {
					calls.promotes += 1;
				},
				rollback: async () => {
					calls.rollbacks += 1;
				},
			},
		}),
		fetch: async (input, init = {}) => {
			const url = new URL(input);
			if (url.pathname !== "/xrpc/sh.tangled.repo.create") {
				throw new Error("unexpected knot request");
			}
			calls.knotCreates += 1;
			assert.equal(init.headers.Authorization, "Bearer SERVICE-TOKEN-CANARY");
			return Response.json({ repoDid: REPO_DID });
		},
	};
	return { repository, identity, metadata, records, calls, session, dependencies };
}

async function expectForkError(promise, stage, code) {
	await assert.rejects(
		promise,
		(error) =>
			error instanceof RookError &&
			error.stage === stage &&
			error.code === code &&
			typeof error.remediation === "string",
	);
}

test("fork matches an equivalent SCP upstream and creates exact state, record, and remote", async (t) => {
	const setup = await setupFork(t);
	const result = await fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies);
	assert.deepEqual(result, {
		upstreamUrl: SOURCE_URL,
		upstreamDefaultBranch: "main",
		knotRepoName: "repo",
		knotRepoDid: REPO_DID,
		rookRemoteUrl: ROOK_URL,
		knot: { outcome: null },
		record: { outcome: "created" },
		remote: { outcome: "created" },
	});
	assert.equal(
		await getRemoteUrl(setup.repository.directory, "rook", setup.dependencies),
		ROOK_URL,
	);
	const commonDir = await resolveGitCommonDir(setup.repository.directory, setup.dependencies);
	assert.deepEqual(await readRepoState(commonDir), {
		version: 1,
		upstreamUrl: SOURCE_URL,
		upstreamDefaultBranch: "main",
		knotRepoName: "repo",
		knotRepoDid: REPO_DID,
		rookRemoteUrl: ROOK_URL,
	});
	assert.deepEqual(setup.calls.lastCreateBody, {
		repo: setup.identity.did,
		collection: "sh.tangled.repo",
		rkey: "repo",
		record: {
			$type: "sh.tangled.repo",
			knot: "knot.rook.host",
			repoDid: REPO_DID,
			source: SOURCE_URL,
			name: "repo",
			createdAt: "2023-11-14T22:13:20.000Z",
		},
	});
});

test("fork refuses credential-bearing and mismatched upstreams without echoing input", async (t) => {
	const setup = await setupFork(t);
	const secret = "https://TOKEN-CANARY@github.com/owner/repo.git";
	let caught;
	try {
		await fork({ upstreamRepoUrl: secret }, setup.dependencies);
	} catch (error) {
		caught = error;
	}
	assert.equal(caught.stage, "validate-upstream");
	assert.equal(caught.code, "upstream-credentials-rejected");
	assert.doesNotMatch(caught.message, /TOKEN-CANARY/);
	assert.equal(setup.calls.knotCreates, 0);

	await expectForkError(
		fork({ upstreamRepoUrl: "https://github.com/owner/other.git" }, setup.dependencies),
		"validate-upstream",
		"upstream-origin-mismatch",
	);
});

test("fork rejects unborn HEAD and missing origin HEAD before knot mutation", async (t) => {
	const unborn = await setupFork(t, { commit: false });
	await expectForkError(
		fork({ upstreamRepoUrl: UPSTREAM_URL }, unborn.dependencies),
		"default-branch",
		"head-unborn",
	);
	assert.equal(unborn.calls.knotCreates, 0);

	const missingHead = await setupFork(t, { remoteHead: false });
	await expectForkError(
		fork({ upstreamRepoUrl: UPSTREAM_URL }, missingHead.dependencies),
		"default-branch",
		"default-branch-missing",
	);
	assert.equal(missingHead.calls.knotCreates, 0);

	const missingRef = await setupFork(t, { remoteRef: false });
	await expectForkError(
		fork({ upstreamRepoUrl: UPSTREAM_URL }, missingRef.dependencies),
		"default-branch",
		"default-branch-ref-missing",
	);
	assert.equal(missingRef.calls.knotCreates, 0);
});

test("fork reports session, scope, and service-auth failures with stable stages and codes", async (t) => {
	await t.test("missing session", async (t) => {
		const setup = await setupFork(t);
		const identityPath = setup.dependencies.env.ROOK_IDENTITY_FILE;
		await fs.unlink(deriveIdentityPaths(identityPath).sessionPath);
		await expectForkError(
			fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies),
			"session",
			"session-missing",
		);
	});

	await t.test("invalid session", async (t) => {
		const setup = await setupFork(t);
		setup.dependencies.restoreSession = async () => {
			throw new RookError("invalid", { code: "session-invalid" });
		};
		await expectForkError(
			fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies),
			"session",
			"session-invalid",
		);
	});

	await t.test("missing scope", async (t) => {
		const setup = await setupFork(t);
		setup.dependencies.restoreSession = async () => ({
			session: setup.session,
			info: { sub: setup.identity.did, scope: "atproto", expired: false },
			transaction: {
				promote: async () => {
					assert.fail("scope-deficient session promoted");
				},
				rollback: async () => {
					setup.calls.rollbacks += 1;
				},
			},
		});
		await expectForkError(
			fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies),
			"session",
			"scope-missing",
		);
		assert.equal(setup.calls.rollbacks, 1);
	});

	await t.test("service auth rejected", async (t) => {
		const setup = await setupFork(t);
		setup.dependencies.mintServiceAuth = async () => {
			throw new RookError("rejected", { code: "service-auth-rejected" });
		};
		await expectForkError(
			fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies),
			"repo-create",
			"service-auth-rejected",
		);
		assert.equal(setup.calls.knotCreates, 0);
	});
});

test("fork adopts an exact record-create race and rejects a lookalike returned URI", async (t) => {
	const raced = await setupFork(t);
	raced.dependencies.createRepoRecord = async (_session, { rkey, record }) => {
		raced.records.set(rkey, record);
		throw new RookError("already exists", { code: "repo-record-conflict" });
	};
	const raceResult = await fork({ upstreamRepoUrl: UPSTREAM_URL }, raced.dependencies);
	assert.equal(raceResult.record.outcome, "adopted");

	const lookalike = await setupFork(t, {
		createRecordUri: "at://did:plc:testrook/sh.tangled.repo/repo-lookalike",
	});
	await expectForkError(
		fork({ upstreamRepoUrl: UPSTREAM_URL }, lookalike.dependencies),
		"repo-record",
		"repo-record-invalid-response",
	);
});

test("fork reruns converge after repo-create, record, remote, and persist failures", async (t) => {
	await t.test("repo-create", async (t) => {
		const setup = await setupFork(t);
		setup.dependencies.createKnotRepo = async () => {
			throw new RookError("offline", { code: "repo-create-rejected" });
		};
		await expectForkError(
			fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies),
			"repo-create",
			"repo-create-rejected",
		);
		setup.dependencies.createKnotRepo = undefined;
		assert.equal(
			(await fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies)).record.outcome,
			"created",
		);
		assert.equal(setup.calls.recordCreates, 1);
	});

	await t.test("repo-record", async (t) => {
		const setup = await setupFork(t);
		setup.dependencies.createRepoRecord = async () => {
			throw new RookError("offline", { code: "repo-record-rejected" });
		};
		await expectForkError(
			fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies),
			"repo-record",
			"repo-record-rejected",
		);
		setup.dependencies.createRepoRecord = undefined;
		await fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies);
		assert.equal(setup.calls.recordCreates, 1);
	});

	await t.test("remote", async (t) => {
		const setup = await setupFork(t);
		setup.dependencies.ensureRemoteUrl = async () => {
			throw new Error("offline");
		};
		await expectForkError(
			fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies),
			"remote",
			"remote-update-failed",
		);
		setup.dependencies.ensureRemoteUrl = undefined;
		const result = await fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies);
		assert.equal(result.record.outcome, "adopted");
		assert.equal(result.remote.outcome, "created");
		assert.equal(setup.calls.recordCreates, 1);
	});

	await t.test("persist", async (t) => {
		const setup = await setupFork(t);
		let failStateRename = true;
		setup.dependencies.fs = new Proxy(fs, {
			get(target, property) {
				if (property === "rename") {
					return async (from, to) => {
						if (failStateRename && to.endsWith(path.join("rook", "state.json"))) {
							failStateRename = false;
							throw new Error("injected state failure");
						}
						return target.rename(from, to);
					};
				}
				const value = target[property];
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await expectForkError(
			fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies),
			"persist",
			"state-write-failed",
		);
		const result = await fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies);
		assert.equal(result.record.outcome, "adopted");
		assert.equal(result.remote.outcome, "unchanged");
		assert.equal(setup.calls.recordCreates, 1);
	});
});

test("fork adopts completed remote side effects after their responses are lost", async (t) => {
	await t.test("knot repo create", async (t) => {
		const setup = await setupFork(t);
		let serverRepoDid;
		let logicalCreates = 0;
		setup.dependencies.createKnotRepo = async () => {
			if (!serverRepoDid) {
				serverRepoDid = REPO_DID;
				logicalCreates += 1;
				throw new RookError("response lost", { code: "repo-create-rejected" });
			}
			return { repoDid: serverRepoDid };
		};
		await expectForkError(
			fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies),
			"repo-create",
			"repo-create-rejected",
		);
		const result = await fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies);
		assert.equal(result.record.outcome, "created");
		assert.equal(logicalCreates, 1);
	});

	await t.test("PDS record create", async (t) => {
		const setup = await setupFork(t);
		let createAttempts = 0;
		setup.dependencies.createRepoRecord = async (_session, { rkey, record }) => {
			createAttempts += 1;
			setup.records.set(rkey, record);
			throw new RookError("response lost", { code: "repo-record-rejected" });
		};
		await expectForkError(
			fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies),
			"repo-record",
			"repo-record-rejected",
		);
		const result = await fork({ upstreamRepoUrl: ORIGIN_URL }, setup.dependencies);
		assert.equal(result.record.outcome, "adopted");
		assert.equal(createAttempts, 1);
		assert.equal(setup.records.get("repo").source, SOURCE_URL);
	});
});

test("an identical fork rerun adopts state and leaves bytes stable", async (t) => {
	const setup = await setupFork(t);
	await fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies);
	const commonDir = await resolveGitCommonDir(setup.repository.directory, setup.dependencies);
	const before = await fs.readFile(repoStatePath(commonDir));
	const rerun = await fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies);
	const after = await fs.readFile(repoStatePath(commonDir));
	assert.equal(rerun.knot.outcome, "adopted");
	assert.equal(rerun.record.outcome, "adopted");
	assert.equal(rerun.remote.outcome, "unchanged");
	assert.equal(setup.calls.recordCreates, 1);
	assert.deepEqual(after, before);
});

test("fork refuses record, remote, and state provenance conflicts", async (t) => {
	await t.test("record", async (t) => {
		const setup = await setupFork(t);
		setup.records.set("repo", {
			$type: "sh.tangled.repo",
			knot: "knot.rook.host",
			repoDid: REPO_DID,
			source: "https://github.com/owner/different.git",
			name: "repo",
			createdAt: "2023-11-14T22:13:20.000Z",
		});
		await expectForkError(
			fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies),
			"derive",
			"repo-record-conflict",
		);
		assert.equal(setup.calls.knotCreates, 0);
	});

	await t.test("remote", async (t) => {
		const setup = await setupFork(t);
		const commonDir = await resolveGitCommonDir(setup.repository.directory, setup.dependencies);
		await writeRepoState(commonDir, {
			upstreamUrl: SOURCE_URL,
			upstreamDefaultBranch: "main",
			knotRepoName: "repo",
			knotRepoDid: REPO_DID,
			rookRemoteUrl: ROOK_URL,
		});
		await setup.repository.run([
			"remote",
			"add",
			"rook",
			"https://knot.rook.host/did:plc:different",
		]);
		await expectForkError(
			fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies),
			"validate-upstream",
			"remote-conflict",
		);
		assert.equal(setup.calls.knotCreates, 0);
	});

	await t.test("state", async (t) => {
		const setup = await setupFork(t);
		const commonDir = await resolveGitCommonDir(setup.repository.directory, setup.dependencies);
		await writeRepoState(commonDir, {
			upstreamUrl: "https://github.com/owner/different.git",
			upstreamDefaultBranch: "main",
			knotRepoName: "different",
			knotRepoDid: REPO_DID,
			rookRemoteUrl: ROOK_URL,
		});
		await expectForkError(
			fork({ upstreamRepoUrl: UPSTREAM_URL }, setup.dependencies),
			"validate-upstream",
			"state-conflict",
		);
		assert.equal(setup.calls.knotCreates, 0);
	});
});

test("fork creates and canonicalizes same-identity rook remotes", async (t) => {
	const created = await setupFork(t);
	assert.equal(
		(await fork({ upstreamRepoUrl: UPSTREAM_URL }, created.dependencies)).remote.outcome,
		"created",
	);

	const updated = await setupFork(t);
	await updated.repository.run(["remote", "add", "rook", `ssh://git@knot.rook.host/${REPO_DID}/`]);
	assert.equal(
		(await fork({ upstreamRepoUrl: UPSTREAM_URL }, updated.dependencies)).remote.outcome,
		"updated",
	);
	assert.equal(
		await getRemoteUrl(updated.repository.directory, "rook", updated.dependencies),
		ROOK_URL,
	);
});

test("fork JSON failures carry structured fields and all command output stays token-free", async (t) => {
	const failed = await setupFork(t);
	const secretUrl = "https://TOKEN-CANARY@github.com/owner/repo.git";
	const failureStdout = memoryStream();
	const failureStderr = memoryStream();
	let program = createProgram({
		...failed.dependencies,
		stdout: failureStdout,
		stderr: failureStderr,
	});
	process.exitCode = 0;
	await program.parseAsync(["node", "rook", "fork", secretUrl, "--json"]);
	process.exitCode = 0;
	const failure = JSON.parse(failureStdout.toString());
	assert.equal(failure.ok, false);
	assert.equal(failure.stage, "validate-upstream");
	assert.equal(failure.code, "upstream-credentials-rejected");
	assert.equal(typeof failure.remediation, "string");
	assert.equal(failureStderr.toString(), "");
	assert.doesNotMatch(failureStdout.toString(), /TOKEN-CANARY/);

	const succeeded = await setupFork(t);
	const successStdout = memoryStream();
	const successStderr = memoryStream();
	program = createProgram({
		...succeeded.dependencies,
		stdout: successStdout,
		stderr: successStderr,
	});
	await program.parseAsync(["node", "rook", "fork", UPSTREAM_URL, "--json"]);
	for (const output of [successStdout.toString(), successStderr.toString()]) {
		assert.doesNotMatch(output, /SERVICE-TOKEN-CANARY/);
	}
});
