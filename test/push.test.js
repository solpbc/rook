// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createProgram } from "../src/cli.js";
import { push } from "../src/cmd/push.js";
import { RookError } from "../src/lib/error-format.js";
import { pushRef, resolveGitCommonDir, runGit } from "../src/lib/git.js";
import { deriveIdentityPaths } from "../src/lib/paths.js";
import { readRepoState, writeRepoState } from "../src/lib/repo-state.js";
import { atomicWriteFile } from "../src/lib/storage.js";
import { memoryStream, temporaryGitRepository } from "./helpers.js";

const DID = "did:plc:testrook";
const REPO_DID = "did:plc:y4n6knl55l5bcoazo6qki4iu";
const ROOK_URL = `https://knot.rook.host/${REPO_DID}`;

async function setupPush(t, options = {}) {
	const repository = await temporaryGitRepository();
	t.after(repository.cleanup);
	const bare = path.join(repository.root, "rook.git");
	await repository.run(["init", "-q", "--bare", bare], { cwd: repository.root });
	let base;
	let tip;
	if (!options.unborn) {
		base = await repository.commit({ message: "base" });
		await repository.run(["remote", "add", "origin", "https://github.com/owner/repo.git"]);
		if (options.baseRef !== false) {
			await repository.run(["update-ref", "refs/remotes/origin/main", base]);
		}
		if (options.branch && options.branch !== "main") {
			await repository.run(["switch", "-q", "-c", options.branch]);
		}
		tip = await repository.commit({
			message: "outgoing",
			authorEmail: options.authorEmail ?? DID,
			committerEmail: options.committerEmail ?? DID,
		});
	} else {
		await repository.run(["remote", "add", "origin", "https://github.com/owner/repo.git"]);
	}
	await repository.run(["remote", "add", "rook", ROOK_URL]);
	if (options.remoteTip === "base" && base) {
		await repository.run(["push", "-q", bare, `${base}:refs/heads/${options.branch ?? "main"}`]);
	}

	const identityPath = path.join(repository.root, "identity.json");
	const paths = deriveIdentityPaths(identityPath);
	await atomicWriteFile(paths.sessionPath, "{}\n");
	const identity = { did: DID, serviceOrigin: "https://rook.invalid" };
	const aud = "did:web:knot.rook.host";
	const scope = ["atproto", `rpc:sh.tangled.git.receivePack?aud=${aud}`].join(" ");
	const commonDir = await resolveGitCommonDir(repository.directory, { env: repository.env });
	if (options.state !== false) {
		await writeRepoState(commonDir, {
			upstreamUrl: "https://github.com/owner/repo.git",
			upstreamDefaultBranch: "main",
			knotRepoName: "repo",
			knotRepoDid: REPO_DID,
			rookRemoteUrl: ROOK_URL,
		});
	}
	const calls = { git: [], mints: [], promotes: 0, rollbacks: 0 };
	const dependencies = {
		cwd: repository.directory,
		env: { ...repository.env, ROOK_IDENTITY_FILE: identityPath },
		readIdentity: async () => identity,
		fetchClientMetadata: async () => ({ scope }),
		restoreSession: async () => ({
			session: { did: DID },
			info: { sub: DID, scope, expired: false },
			transaction: {
				promote: async () => {
					calls.promotes += 1;
				},
				rollback: async () => {
					calls.rollbacks += 1;
				},
			},
		}),
		mintServiceAuth: async (_session, request) => {
			calls.mints.push(request);
			return `PUSH-TOKEN-CANARY-${calls.mints.length}`;
		},
		runGit: async (args, gitOptions) => {
			calls.git.push({ args: [...args], env: gitOptions.env });
			const localArgs = [...args];
			if (localArgs[0] === "push" && localArgs[2] === "rook") localArgs[2] = bare;
			if (localArgs[0] === "ls-remote" && localArgs[1] === "rook") localArgs[1] = bare;
			return runGit(localArgs, gitOptions, { env: repository.env });
		},
	};
	return {
		repository,
		bare,
		base,
		tip,
		branch: options.branch ?? "main",
		commonDir,
		calls,
		dependencies,
	};
}

async function expectPushError(promise, stage, code) {
	await assert.rejects(
		promise,
		(error) =>
			error.stage === stage && error.code === code && typeof error.remediation === "string",
	);
}

test("push gates detached, unborn, missing branch, missing state, and missing base locally", async (t) => {
	await t.test("detached", async (t) => {
		const setup = await setupPush(t);
		await setup.repository.run(["switch", "-q", "--detach", "HEAD"]);
		await expectPushError(push({ json: true }, setup.dependencies), "gate", "branch-detached");
		assert.equal(setup.calls.mints.length, 0);
	});

	await t.test("unborn", async (t) => {
		const setup = await setupPush(t, { unborn: true });
		await expectPushError(push({ json: true }, setup.dependencies), "gate", "head-unborn");
		assert.equal(setup.calls.mints.length, 0);
	});

	await t.test("missing explicit branch", async (t) => {
		const setup = await setupPush(t);
		await expectPushError(
			push({ branch: "extro/missing", json: true }, setup.dependencies),
			"gate",
			"branch-missing",
		);
		assert.equal(setup.calls.mints.length, 0);
	});

	await t.test("missing state", async (t) => {
		const setup = await setupPush(t, { state: false });
		await expectPushError(push({ json: true }, setup.dependencies), "gate", "state-missing");
		assert.equal(setup.calls.mints.length, 0);
	});

	await t.test("missing base", async (t) => {
		const setup = await setupPush(t, { baseRef: false });
		await expectPushError(push({ json: true }, setup.dependencies), "gate", "base-ref-missing");
		assert.equal(setup.calls.mints.length, 0);
	});
});

test("push provenance requires byte-exact author and committer DID emails without rewriting", async (t) => {
	for (const [name, authorEmail, committerEmail] of [
		["case-folded", DID.toUpperCase(), DID],
		["substring", `${DID}.extra`, DID],
		["display-name", `${DID} display`, DID],
		["author-only", DID, "wrong@example.invalid"],
	]) {
		await t.test(name, async (t) => {
			const setup = await setupPush(t, { authorEmail, committerEmail });
			const before = (await setup.repository.run(["rev-parse", "HEAD"])).stdout.trim();
			let caught;
			try {
				await push({ json: true }, setup.dependencies);
			} catch (error) {
				caught = error;
			}
			assert.equal(caught.stage, "gate");
			assert.equal(caught.code, "provenance-mismatch");
			assert.match(caught.message, new RegExp(setup.tip));
			assert.match(caught.message, /author=/);
			assert.match(caught.message, /committer=/);
			assert.match(caught.remediation, /git rebase -i/);
			assert.equal((await setup.repository.run(["rev-parse", "HEAD"])).stdout.trim(), before);
			assert.equal(setup.calls.mints.length, 0);
		});
	}
});

test("push rejects an equivalent SSH rook remote before minting or pushing", async (t) => {
	const setup = await setupPush(t);
	await setup.repository.run(["remote", "set-url", "rook", `ssh://git@knot.rook.host/${REPO_DID}`]);
	await expectPushError(push({ json: true }, setup.dependencies), "gate", "remote-conflict");
	assert.equal(setup.calls.mints.length, 0);
	assert.equal(
		setup.calls.git.some(({ args }) => args[0] === "push"),
		false,
	);
});

test("push reports session, mint, and persistence failures at stable stages", async (t) => {
	await t.test("session missing", async (t) => {
		const setup = await setupPush(t);
		await fs.unlink(deriveIdentityPaths(setup.dependencies.env.ROOK_IDENTITY_FILE).sessionPath);
		await expectPushError(push({ json: true }, setup.dependencies), "session", "session-missing");
	});

	await t.test("mint rejected", async (t) => {
		const setup = await setupPush(t);
		setup.dependencies.mintServiceAuth = async () => {
			throw new RookError("rejected", { code: "service-auth-rejected" });
		};
		await expectPushError(
			push({ json: true }, setup.dependencies),
			"mint",
			"service-auth-rejected",
		);
	});

	await t.test("persist", async (t) => {
		const setup = await setupPush(t);
		setup.dependencies.writeRepoState = async () => {
			throw new Error("injected write failure");
		};
		await expectPushError(
			push({ json: true }, setup.dependencies),
			"persist",
			"state-write-failed",
		);
		assert.equal((await readRepoState(setup.commonDir)).lastPushedTip, undefined);
	});
});

test("push uses env-only fresh auth, verifies equality, and persists only the proof", async (t) => {
	const setup = await setupPush(t, { branch: "extro/topic" });
	const result = await push({ branch: "extro/topic", json: true }, setup.dependencies);
	assert.deepEqual(result, {
		branch: "extro/topic",
		tip: setup.tip,
		rookRemoteUrl: ROOK_URL,
		pushCompleted: true,
		remoteVerified: true,
	});
	assert.deepEqual(
		setup.calls.mints.map(({ expSeconds }) => expSeconds),
		[300, undefined],
	);
	const authenticated = setup.calls.git.filter(({ env }) => env?.GIT_CONFIG_VALUE_0);
	assert.equal(authenticated.length, 2);
	assert.match(authenticated[0].env.GIT_CONFIG_VALUE_0, /PUSH-TOKEN-CANARY-1/);
	assert.match(authenticated[1].env.GIT_CONFIG_VALUE_0, /PUSH-TOKEN-CANARY-2/);
	for (const { args } of authenticated) {
		assert.doesNotMatch(JSON.stringify(args), /PUSH-TOKEN-CANARY/);
	}
	assert.deepEqual(await readRepoState(setup.commonDir), {
		version: 1,
		upstreamUrl: "https://github.com/owner/repo.git",
		upstreamDefaultBranch: "main",
		knotRepoName: "repo",
		knotRepoDid: REPO_DID,
		rookRemoteUrl: ROOK_URL,
		lastPushedBranch: "extro/topic",
		lastPushedTip: setup.tip,
	});
});

for (const outcome of ["nonzero", "timeout"]) {
	test(`push treats a ${outcome} subprocess as provisional when remote equality succeeds`, async (t) => {
		const setup = await setupPush(t);
		setup.dependencies.pushRef = async (...args) => {
			const completed = await pushRef(...args);
			if (outcome === "timeout") throw new Error("git push timed out");
			return { ...completed, status: 1, stderr: "git reported failure" };
		};
		const result = await push({ json: true }, setup.dependencies);
		assert.equal(result.remoteVerified, true);
		assert.equal((await readRepoState(setup.commonDir)).lastPushedTip, setup.tip);
	});
}

test("push verification mismatch and missing ref fail without persisting proof", async (t) => {
	await t.test("mismatch", async (t) => {
		const setup = await setupPush(t, { remoteTip: "base" });
		setup.dependencies.pushRef = async () => ({
			status: 1,
			stdout: "",
			stderr: "push rejected",
		});
		await expectPushError(
			push({ json: true }, setup.dependencies),
			"verify",
			"remote-tip-mismatch",
		);
		assert.equal((await readRepoState(setup.commonDir)).lastPushedTip, undefined);
	});

	await t.test("missing", async (t) => {
		const setup = await setupPush(t);
		setup.dependencies.pushRef = async () => ({
			status: 1,
			stdout: "",
			stderr: "push rejected",
		});
		await expectPushError(push({ json: true }, setup.dependencies), "verify", "remote-ref-missing");
		assert.equal((await readRepoState(setup.commonDir)).lastPushedTip, undefined);
	});
});

test("push JSON verification failures are structured and token-free", async (t) => {
	const setup = await setupPush(t);
	setup.dependencies.pushRef = async () => ({
		status: 1,
		stdout: "",
		stderr: "Authorization: Bearer PUSH-TOKEN-CANARY-1",
	});
	const stdout = memoryStream();
	const stderr = memoryStream();
	const program = createProgram({ ...setup.dependencies, stdout, stderr });
	process.exitCode = 0;
	await program.parseAsync(["node", "rook", "push", "--json"]);
	const exitCode = process.exitCode;
	process.exitCode = 0;
	const result = JSON.parse(stdout.toString());
	assert.equal(exitCode, 1);
	assert.equal(result.ok, false);
	assert.equal(result.stage, "verify");
	assert.equal(result.code, "remote-ref-missing");
	assert.equal(result.remediation, "run rook push");
	assert.equal(stderr.toString(), "");
	assert.doesNotMatch(stdout.toString(), /PUSH-TOKEN-CANARY/);
});

test("push redacts reflected credentials in the verification error cause", async (t) => {
	const setup = await setupPush(t);
	const canary = "REFLECTED-PUSH-TOKEN-CANARY-1234567890";
	setup.dependencies.pushRef = async () => ({
		status: 1,
		stdout: "",
		stderr: `Authorization: Bearer ${canary}`,
	});
	let caught;
	try {
		await push({ json: true }, setup.dependencies);
	} catch (error) {
		caught = error;
	}
	assert.equal(caught.code, "remote-ref-missing");
	assert.ok(caught.cause instanceof Error);
	assert.doesNotMatch(caught.cause.message, new RegExp(canary));
	assert.match(caught.cause.message, /\[REDACTED\]/);
});

test("push failure output never contains a token passed through Git auth env", async (t) => {
	const setup = await setupPush(t, { remoteTip: "base" });
	setup.dependencies.pushRef = async () => ({ status: 1, stdout: "", stderr: "failed" });
	let caught;
	try {
		await push({ json: true }, setup.dependencies);
	} catch (error) {
		caught = error;
	}
	assert.doesNotMatch(JSON.stringify(caught), /PUSH-TOKEN-CANARY/);
	assert.equal(
		(await fs.readFile(path.join(setup.repository.directory, ".git", "config"), "utf8")).includes(
			"PUSH-TOKEN-CANARY",
		),
		false,
	);
});
