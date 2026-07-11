// SPDX-License-Identifier: AGPL-3.0-only

import { RookError } from "../lib/error-format.js";
import {
	buildGitAuthEnv,
	currentBranch,
	enumerateProvenance,
	getRemoteUrl,
	lsRemoteRef,
	normalizeRepoIdentity,
	pushRef,
	resolveCommit,
	resolveGitCommonDir,
	validateBranchName,
} from "../lib/git.js";
import { readIdentity } from "../lib/identity.js";
import { createOutput } from "../lib/json-output.js";
import { deriveKnotTarget } from "../lib/knot.js";
import { fetchClientMetadata, missingScopes } from "../lib/oauth.js";
import { deriveIdentityPaths, resolveIdentityPath } from "../lib/paths.js";
import { redactText } from "../lib/redact.js";
import { readRepoState, writeRepoState } from "../lib/repo-state.js";
import { mintServiceAuth } from "../lib/service-auth.js";
import { restoreSession } from "../lib/session.js";
import { fileExists } from "../lib/storage.js";

const RETRY_PUSH = "run rook push";

function failure(error, { stage, code, remediation, message, forceCode = false, cause }) {
	if (error instanceof RookError) {
		return new RookError(message ?? error.message, {
			cause: cause ?? error.cause,
			hint: error.hint,
			stage: error.stage ?? stage,
			code: forceCode ? code : (error.code ?? code),
			remediation: error.remediation ?? remediation,
		});
	}
	return new RookError(message, { cause, stage, code, remediation });
}

async function attempt(action, options) {
	try {
		return await action();
	} catch (error) {
		throw failure(error, options);
	}
}

function provenanceRemediation(identity, base) {
	return [
		`git config user.email '${identity.did}'`,
		`git rebase -i ${base}`,
		"mark each offending commit for edit",
		"git commit --amend --reset-author",
		"git rebase --continue",
		"review the rewritten history before rerunning rook push",
	].join("; ");
}

function pushContext(result) {
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
	return new Error(output || `git push exited with status ${result.status}`);
}

function emitPushProgress(result, options, dependencies) {
	if (options.json) return;
	const output = [result.stdout, result.stderr].filter(Boolean).join("");
	if (output !== "") {
		try {
			(dependencies.stderr ?? process.stderr).write(redactText(output));
		} catch {
			// Progress rendering cannot replace the authenticated equality proof.
		}
	}
}

function sameKnotHost(state, knot) {
	try {
		return new URL(state.rookRemoteUrl).host.toLowerCase() === knot.host.toLowerCase();
	} catch {
		return false;
	}
}

async function mintReceivePack(session, identity, knot, expSeconds, dependencies) {
	return (dependencies.mintServiceAuth ?? mintServiceAuth)(
		session,
		{
			serviceOrigin: identity.serviceOrigin,
			aud: knot.aud,
			lxm: "sh.tangled.git.receivePack",
			...(expSeconds === undefined ? {} : { expSeconds }),
		},
		dependencies,
	);
}

export async function push(options, dependencies = {}) {
	const cwd = dependencies.cwd ?? process.cwd();
	const gitCommonDir = await attempt(() => resolveGitCommonDir(cwd, dependencies), {
		stage: "gate",
		code: "not-git-repository",
		remediation: "run this command inside a configured git clone",
		message: "current directory is not a Git repository",
	});
	const state = await attempt(
		() => (dependencies.readRepoState ?? readRepoState)(gitCommonDir, dependencies),
		{
			stage: "gate",
			code: "state-invalid",
			remediation: "repair the repository rook state before retrying",
			message: "repository rook state is invalid",
		},
	);
	if (!state) {
		throw new RookError("repository has not been forked for this rook", {
			stage: "gate",
			code: "state-missing",
			remediation: "run rook fork <upstream-repo-url>",
		});
	}

	let identityPath;
	try {
		identityPath = resolveIdentityPath(options, dependencies.env, cwd);
	} catch {
		throw new RookError("selected identity path is invalid", {
			stage: "gate",
			code: "identity-invalid",
			remediation: "run rook enroll --invite <url> --handle <name>",
		});
	}
	const identity = await attempt(() => (dependencies.readIdentity ?? readIdentity)(identityPath), {
		stage: "gate",
		code: "identity-invalid",
		remediation: "run rook enroll --invite <url> --handle <name>",
		message: "selected identity is invalid",
	});
	if (!identity) {
		throw new RookError("no enrolled identity is available", {
			stage: "gate",
			code: "identity-invalid",
			remediation: "run rook enroll --invite <url> --handle <name>",
		});
	}

	let branch = options.branch;
	let headBranch;
	if (branch === undefined) {
		headBranch = await attempt(() => currentBranch(cwd, dependencies), {
			stage: "gate",
			code: "branch-detached",
			remediation: "git switch <branch>",
			message: "HEAD is detached",
		});
		if (headBranch === undefined) {
			throw new RookError("HEAD is detached", {
				stage: "gate",
				code: "branch-detached",
				remediation: "git switch <branch>",
			});
		}
		branch = headBranch;
	}
	await attempt(() => validateBranchName(cwd, branch, dependencies), {
		stage: "gate",
		code: "branch-invalid",
		remediation: "use a valid local branch name",
		message: "branch name is invalid",
	});
	let localTip;
	try {
		localTip = await resolveCommit(cwd, `refs/heads/${branch}`, dependencies);
	} catch (error) {
		if (headBranch === undefined && options.branch !== undefined) {
			headBranch = await currentBranch(cwd, dependencies).catch(() => undefined);
		}
		const isHeadBranch = options.branch === undefined || headBranch === branch;
		throw failure(error, {
			stage: "gate",
			code: isHeadBranch ? "head-unborn" : "branch-missing",
			forceCode: true,
			remediation: isHeadBranch
				? "make an initial commit or check out a branch with commits"
				: "create or fetch the requested branch before retrying",
			message: isHeadBranch ? "HEAD has no commit" : "requested branch does not exist",
		});
	}
	const base = await attempt(
		() => resolveCommit(cwd, `refs/remotes/origin/${state.upstreamDefaultBranch}`, dependencies),
		{
			stage: "gate",
			code: "base-ref-missing",
			forceCode: true,
			remediation: "git fetch origin; rerun rook fork if the default branch moved",
			message: "stored upstream default branch ref is missing",
		},
	);
	const provenance = await attempt(() => enumerateProvenance(cwd, base, localTip, dependencies), {
		stage: "gate",
		code: "provenance-mismatch",
		remediation: provenanceRemediation(identity, base),
		message: "outgoing commit provenance could not be inspected",
	});
	const offenders = provenance.filter(
		({ authorEmail, committerEmail }) =>
			authorEmail !== identity.did || committerEmail !== identity.did,
	);
	if (offenders.length > 0) {
		const detail = offenders
			.map(
				({ hash, authorEmail, committerEmail }) =>
					`${hash}: author=${authorEmail}; committer=${committerEmail}`,
			)
			.join("\n");
		throw new RookError(`outgoing commits have invalid rook provenance\n${detail}`, {
			stage: "gate",
			code: "provenance-mismatch",
			remediation: provenanceRemediation(identity, base),
		});
	}
	const rookRemote = await attempt(() => getRemoteUrl(cwd, "rook", dependencies), {
		stage: "gate",
		code: "remote-conflict",
		remediation: "run rook fork <upstream-repo-url>",
		message: "rook remote is unavailable",
	});
	let remoteMatches = false;
	try {
		remoteMatches =
			rookRemote !== undefined &&
			normalizeRepoIdentity(rookRemote) === normalizeRepoIdentity(state.rookRemoteUrl);
	} catch {
		remoteMatches = false;
	}
	if (!remoteMatches) {
		throw new RookError("rook remote does not match repository state", {
			stage: "gate",
			code: "remote-conflict",
			remediation: "run rook fork <upstream-repo-url>",
		});
	}

	const metadata = await attempt(
		() =>
			(dependencies.fetchClientMetadata ?? fetchClientMetadata)(
				identity.serviceOrigin,
				dependencies,
			),
		{
			stage: "session",
			code: "session-invalid",
			remediation: "run rook login",
			message: "OAuth client metadata is unavailable",
		},
	);
	const paths = deriveIdentityPaths(identityPath);
	const hasSession = await attempt(() => fileExists(paths.sessionPath, dependencies.fs), {
		stage: "session",
		code: "session-invalid",
		remediation: "run rook login",
		message: "OAuth session storage could not be inspected",
	});
	if (!hasSession) {
		throw new RookError("no OAuth session is stored", {
			stage: "session",
			code: "session-missing",
			remediation: "run rook login",
		});
	}
	const restored = await attempt(
		() => (dependencies.restoreSession ?? restoreSession)(identity, metadata, paths, dependencies),
		{
			stage: "session",
			code: "session-invalid",
			remediation: "run rook login",
			message: "OAuth session is invalid or unrefreshable",
		},
	);
	let promoted = false;
	let knot;
	try {
		const missing = missingScopes(metadata.scope, restored.info.scope);
		if (missing.length > 0) {
			throw new RookError(`OAuth grant is missing required scopes: ${missing.join(" ")}`, {
				stage: "session",
				code: "scope-missing",
				remediation: "run rook login",
			});
		}
		try {
			knot = deriveKnotTarget(metadata.scope);
		} catch {
			throw new RookError("served OAuth scope has no valid knot target", {
				stage: "session",
				code: "knot-target-invalid",
				remediation: "run rook login",
			});
		}
		if (!sameKnotHost(state, knot)) {
			throw new RookError("repository state belongs to a different knot", {
				stage: "session",
				code: "state-conflict",
				remediation: "run rook fork <upstream-repo-url>",
			});
		}
		await restored.transaction.promote();
		promoted = true;
	} catch (error) {
		throw failure(error, {
			stage: "session",
			code: "session-invalid",
			remediation: "run rook login",
			message: error instanceof RookError ? undefined : "OAuth session could not be promoted",
		});
	} finally {
		if (!promoted) await restored.transaction.rollback().catch(() => {});
	}
	const session = restored.session;

	let pushToken;
	try {
		pushToken = await mintReceivePack(session, identity, knot, 300, dependencies);
	} catch (error) {
		throw failure(error, {
			stage: "mint",
			code: error?.code === "service-auth-rejected" ? "service-auth-rejected" : "push-rejected",
			forceCode: true,
			remediation: error?.code === "service-auth-rejected" ? "run rook login" : RETRY_PUSH,
			message: "could not mint receive-pack authorization",
		});
	}
	const pushAuthEnv = await attempt(
		() => buildGitAuthEnv(state.rookRemoteUrl, pushToken, dependencies.env ?? process.env),
		{
			stage: "mint",
			code: "service-auth-rejected",
			remediation: "run rook login",
			message: "receive-pack authorization is invalid",
		},
	);

	let pushResult;
	try {
		pushResult = await (dependencies.pushRef ?? pushRef)(
			cwd,
			"rook",
			`refs/heads/${branch}`,
			`refs/heads/${branch}`,
			pushAuthEnv,
			{ timeoutMs: 240_000 },
			dependencies,
		);
	} catch (error) {
		pushResult = { status: 1, stdout: "", stderr: redactText(error?.message ?? "git push failed") };
	}
	emitPushProgress(pushResult, options, dependencies);
	const context = pushContext(pushResult);

	let verifyToken;
	try {
		verifyToken = await mintReceivePack(session, identity, knot, undefined, dependencies);
	} catch (error) {
		throw failure(error, {
			stage: "verify",
			code: error?.code === "service-auth-rejected" ? "service-auth-rejected" : "push-rejected",
			forceCode: true,
			remediation: RETRY_PUSH,
			message: "could not mint fresh verification authorization",
			cause: context,
		});
	}
	const verifyAuthEnv = await attempt(
		() => buildGitAuthEnv(state.rookRemoteUrl, verifyToken, dependencies.env ?? process.env),
		{
			stage: "verify",
			code: "service-auth-rejected",
			remediation: RETRY_PUSH,
			message: "verification authorization is invalid",
			cause: context,
		},
	);
	let remoteTip;
	try {
		remoteTip = await (dependencies.lsRemoteRef ?? lsRemoteRef)(
			cwd,
			"rook",
			`refs/heads/${branch}`,
			verifyAuthEnv,
			dependencies,
		);
	} catch (error) {
		throw failure(error, {
			stage: "verify",
			code: error?.code ?? "push-rejected",
			remediation: RETRY_PUSH,
			message: error instanceof RookError ? undefined : "remote ref could not be verified",
			cause: context,
		});
	}
	if (remoteTip !== localTip) {
		throw new RookError("remote branch tip does not match the local tip", {
			cause: context,
			stage: "verify",
			code: "remote-tip-mismatch",
			remediation: RETRY_PUSH,
		});
	}

	await attempt(
		() =>
			(dependencies.writeRepoState ?? writeRepoState)(
				gitCommonDir,
				{ lastPushedBranch: branch, lastPushedTip: localTip },
				dependencies,
			),
		{
			stage: "persist",
			code: "state-write-failed",
			forceCode: true,
			remediation: RETRY_PUSH,
			message: "could not persist the verified push proof",
		},
	);

	return {
		branch,
		tip: localTip,
		rookRemoteUrl: state.rookRemoteUrl,
		pushCompleted: true,
		remoteVerified: true,
	};
}

export function register(program, dependencies = {}) {
	program
		.command("push")
		.description("push provenance-checked commits to the rook knot and prove the remote ref")
		.argument("[branch]")
		.option("--json", "emit structured JSON")
		.action(async (branch, localOptions, command) => {
			const output = createOutput({ ...dependencies, json: localOptions.json });
			try {
				const result = await push(
					{ ...command.optsWithGlobals(), branch, json: localOptions.json },
					dependencies,
				);
				output.success(
					result,
					`pushed ${result.branch} to ${result.rookRemoteUrl}\nremote verified at ${result.tip}`,
				);
			} catch (error) {
				output.failure(error);
				process.exitCode = 1;
			}
		});
}
