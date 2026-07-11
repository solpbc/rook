// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
	buildGitAuthEnv,
	canonicalRepoSource,
	currentBranch,
	ensureRemoteUrl,
	enumerateProvenance,
	getRemoteUrl,
	lsRemoteRef,
	normalizeRepoIdentity,
	pushRef,
	remoteHeadBranch,
	resolveCommit,
	resolveGitCommonDir,
	runGit,
} from "../src/lib/git.js";
import { temporaryGitRepository } from "./helpers.js";

async function gitRepository(t, options = {}) {
	const repository = await temporaryGitRepository(options);
	t.after(repository.cleanup);
	return repository;
}

test("repository URL identity folds HTTPS, SCP-like SSH, ssh URL, suffix, slash, host case, and default ports", () => {
	const expected = "example.com/Owner/Repo";
	for (const input of [
		"https://Example.COM:443/Owner/Repo.git/",
		"git@example.com:Owner/Repo.git",
		"ssh://git@EXAMPLE.com:22/Owner/Repo/",
		"ssh://example.com/Owner/Repo",
	]) {
		assert.equal(normalizeRepoIdentity(input), expected);
	}
	assert.equal(
		canonicalRepoSource("git@Example.COM:Owner/Repo.git"),
		"https://example.com/Owner/Repo.git",
	);
	assert.equal(
		canonicalRepoSource("https://Example.COM:443/Owner/Repo.git/"),
		"https://example.com/Owner/Repo.git/",
	);
});

test("repository URL validation rejects credentials and unsafe suffixes without echoing input", () => {
	for (const [input, secret] of [
		["https://user:password-canary@example.com/owner/repo.git", "password-canary"],
		["https://token-canary@example.com/owner/repo.git", "token-canary"],
		["ssh://alice@example.com/owner/repo.git", "alice"],
		["alice@example.com:owner/repo.git", "alice"],
		["https://example.com/owner/repo.git?token=query-canary", "query-canary"],
		["https://example.com/owner/repo.git#fragment-canary", "fragment-canary"],
		["https://example.com/owner/repo.git\ncontrol-canary", "control-canary"],
	]) {
		let error;
		try {
			normalizeRepoIdentity(input);
		} catch (caught) {
			error = caught;
		}
		assert.ok(error);
		assert.doesNotMatch(error.message, new RegExp(secret));
	}
});

test("Git auth overlay uses only the exact full repository URL", () => {
	const remoteUrl = "https://knot.rook.host/did:plc:repo";
	const env = buildGitAuthEnv(remoteUrl, "service-token-canary", { KEEP: "yes" });
	assert.deepEqual(env, {
		KEEP: "yes",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "http.https://knot.rook.host/did:plc:repo.extraHeader",
		GIT_CONFIG_VALUE_0: "Authorization: Bearer service-token-canary",
		GIT_TERMINAL_PROMPT: "0",
	});
	assert.notEqual(env.GIT_CONFIG_KEY_0, "http.https://knot.rook.host.extraHeader");
});

test("runGit returns success, throws on failure, and redacts stderr", async () => {
	const success = await runGit(["--version"]);
	assert.equal(success.status, 0);
	assert.match(success.stdout, /^git version /);

	await assert.rejects(runGit(["definitely-not-a-git-command"]), /git command failed/);

	const secret = "AUTHORIZATION-SECRET-1234567890";
	const env = {
		...process.env,
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "alias.rook-redaction-probe",
		GIT_CONFIG_VALUE_0: '!printf "%s\\n" "$ROOK_TEST_SECRET" >&2; exit 1',
		ROOK_TEST_SECRET: `Authorization: Bearer ${secret}`,
	};
	await assert.rejects(runGit(["rook-redaction-probe"], { env }), (error) => {
		assert.doesNotMatch(error.cause.message, new RegExp(secret));
		assert.match(error.cause.message, /\[REDACTED\]/);
		return true;
	});
});

test("runGit treats bounded-buffer overflow as a fail-closed boundary error", async () => {
	await assert.rejects(
		runGit(["--version"], { allowFailure: true }, { maxGitOutputBytes: 8 }),
		/output exceeded the configured limit/,
	);
});

test("normal and linked worktrees resolve the same absolute Git common directory", async (t) => {
	const repository = await gitRepository(t);
	await repository.commit({ message: "base" });
	const linked = await repository.addLinkedWorktree();
	const mainCommon = await resolveGitCommonDir(repository.directory, { env: repository.env });
	const linkedCommon = await resolveGitCommonDir(linked, { env: repository.env });
	assert.equal(mainCommon, linkedCommon);
	assert.equal(path.isAbsolute(mainCommon), true);
});

test("current branch distinguishes attached and detached HEAD", async (t) => {
	const repository = await gitRepository(t);
	await repository.commit();
	assert.equal(await currentBranch(repository.directory, { env: repository.env }), "main");
	await repository.run(["switch", "-q", "--detach", "HEAD"]);
	assert.equal(await currentBranch(repository.directory, { env: repository.env }), undefined);
});

test("remote HEAD strictly resolves a slash-containing branch for the requested remote", async (t) => {
	const repository = await gitRepository(t);
	await repository.commit();
	await repository.run(["update-ref", "refs/remotes/origin/extro/topic", "HEAD"]);
	await repository.run([
		"symbolic-ref",
		"refs/remotes/origin/HEAD",
		"refs/remotes/origin/extro/topic",
	]);
	assert.equal(
		await remoteHeadBranch(repository.directory, "origin", { env: repository.env }),
		"extro/topic",
	);
});

test("resolveCommit identifies unborn HEAD and missing revisions", async (t) => {
	const unborn = await gitRepository(t);
	await assert.rejects(
		resolveCommit(unborn.directory, "HEAD", { env: unborn.env }),
		(error) => error.code === "head-unborn",
	);

	const repository = await gitRepository(t);
	await repository.commit();
	await assert.rejects(
		resolveCommit(repository.directory, "refs/remotes/origin/missing", {
			env: repository.env,
		}),
		(error) => error.code === "base-ref-missing",
	);
});

test("enumerateProvenance returns every outgoing hash with distinct author and committer emails", async (t) => {
	const repository = await gitRepository(t);
	const base = await repository.commit({ message: "base" });
	const tip = await repository.commit({
		message: "outgoing",
		authorEmail: "author@example.invalid",
		committerEmail: "committer@example.invalid",
	});
	assert.deepEqual(
		await enumerateProvenance(repository.directory, base, tip, { env: repository.env }),
		[
			{
				hash: tip,
				authorEmail: "author@example.invalid",
				committerEmail: "committer@example.invalid",
			},
		],
	);
});

test("lsRemoteRef requires exactly one exact row and treats empty success as missing", async (t) => {
	const repository = await gitRepository(t);
	const tip = await repository.commit();
	const bare = path.join(repository.root, "remote.git");
	await runGit(["init", "-q", "--bare", bare], { cwd: repository.root, env: repository.env });
	await repository.run(["push", "-q", bare, "HEAD:refs/heads/main"]);
	assert.equal(
		await lsRemoteRef(repository.directory, bare, "refs/heads/main", repository.env),
		tip,
	);
	await assert.rejects(
		lsRemoteRef(repository.directory, bare, "refs/heads/missing", repository.env),
		(error) => error.code === "remote-ref-missing",
	);

	const runGitFake = async () => ({
		status: 0,
		stdout: `${tip}\trefs/heads/main\n${tip}\trefs/heads/main\n`,
		stderr: "",
	});
	await assert.rejects(
		lsRemoteRef("/tmp", "remote", "refs/heads/main", {}, { runGit: runGitFake }),
		(error) => error.code === "remote-ref-ambiguous",
	);
});

test("ensureRemoteUrl adds, no-ops, canonicalizes equivalents, and refuses conflicts", async (t) => {
	const repository = await gitRepository(t);
	const first = "https://example.com/owner/repo.git";
	assert.deepEqual(
		await ensureRemoteUrl(repository.directory, "rook", first, { env: repository.env }),
		{
			outcome: "created",
			url: first,
		},
	);
	assert.equal(await getRemoteUrl(repository.directory, "rook", { env: repository.env }), first);
	assert.equal(
		(await ensureRemoteUrl(repository.directory, "rook", first, { env: repository.env })).outcome,
		"unchanged",
	);

	const equivalent = "ssh://git@example.com/owner/repo/";
	assert.equal(
		(await ensureRemoteUrl(repository.directory, "rook", equivalent, { env: repository.env }))
			.outcome,
		"updated",
	);
	assert.equal(
		await getRemoteUrl(repository.directory, "rook", { env: repository.env }),
		equivalent,
	);
	await assert.rejects(
		ensureRemoteUrl(repository.directory, "rook", "https://example.com/owner/other.git", {
			env: repository.env,
		}),
		(error) => error.code === "remote-conflict",
	);
});

test("pushRef preserves slash-containing branch names in the full refspec", async (t) => {
	const repository = await gitRepository(t);
	await repository.commit();
	const branch = "extro/add-json-schema-constrained-decoding";
	await repository.run(["switch", "-q", "-c", branch]);
	const tip = await resolveCommit(repository.directory, "HEAD", { env: repository.env });
	const bare = path.join(repository.root, "push.git");
	await runGit(["init", "-q", "--bare", bare], { cwd: repository.root, env: repository.env });
	await repository.run(["remote", "add", "rook", bare]);
	const result = await pushRef(
		repository.directory,
		"rook",
		`refs/heads/${branch}`,
		`refs/heads/${branch}`,
		repository.env,
		{ timeoutMs: 5000 },
		{ env: repository.env },
	);
	assert.equal(result.status, 0);
	assert.equal(
		await lsRemoteRef(repository.directory, bare, `refs/heads/${branch}`, repository.env),
		tip,
	);
});
