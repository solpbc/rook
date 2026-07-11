// SPDX-License-Identifier: AGPL-3.0-only

import { RookError } from "../lib/error-format.js";
import {
	canonicalRepoSource,
	ensureRemoteUrl,
	getRemoteUrl,
	normalizeRepoIdentity,
	remoteHeadBranch,
	resolveCommit,
	resolveGitCommonDir,
} from "../lib/git.js";
import { readIdentity } from "../lib/identity.js";
import { createOutput } from "../lib/json-output.js";
import { resolveIdentityPath } from "../lib/paths.js";
import { readRepoState, writeRepoState } from "../lib/repo-state.js";
import { mintServiceAuth } from "../lib/service-auth.js";
import { restoreContext } from "../lib/session-context.js";
import {
	createKnotRepo,
	createRepoRecord,
	deriveKnotRepoName,
	deriveRepoUrl,
	readRepoRecord,
	repoRecordMatches,
} from "../lib/tangled.js";

const RETRY_FORK = "run rook fork <upstream-repo-url> again";

function failure(error, { stage, code, remediation, message, forceCode = false }) {
	if (error instanceof RookError) {
		return new RookError(message ?? error.message, {
			cause: error.cause,
			hint: error.hint,
			stage: error.stage ?? stage,
			code: forceCode ? code : (error.code ?? code),
			remediation: error.remediation ?? remediation,
		});
	}
	return new RookError(message, { stage, code, remediation });
}

async function attempt(action, options) {
	try {
		return await action();
	} catch (error) {
		throw failure(error, options);
	}
}

function recordExpected(knot, repoDid, source, name) {
	return {
		$type: "sh.tangled.repo",
		knot: knot.host,
		repoDid,
		source,
		name,
	};
}

function recordPreflightMatches(record, knot, upstreamIdentity, name) {
	if (record?.$type !== "sh.tangled.repo" || record?.knot !== knot.host || record?.name !== name) {
		return false;
	}
	try {
		return normalizeRepoIdentity(record.source) === upstreamIdentity;
	} catch {
		return false;
	}
}

function recordDid(record, knot) {
	try {
		deriveRepoUrl(knot.host, record.repoDid);
		return record.repoDid;
	} catch {
		return undefined;
	}
}

function sameKnotHost(state, knot) {
	try {
		return new URL(state.rookRemoteUrl).host.toLowerCase() === knot.host.toLowerCase();
	} catch {
		return false;
	}
}

export async function forkCore(options, providedContext, dependencies = {}) {
	const cwd = dependencies.cwd ?? process.cwd();
	const upstream = options.upstreamRepoUrl;
	const gitCommonDir = await attempt(() => resolveGitCommonDir(cwd, dependencies), {
		stage: "validate-upstream",
		code: "not-git-repository",
		remediation: "run this command inside a git clone",
		message: "current directory is not a Git repository",
	});
	const state = await attempt(
		() => (dependencies.readRepoState ?? readRepoState)(gitCommonDir, dependencies),
		{
			stage: "validate-upstream",
			code: "state-invalid",
			remediation: "repair the repository rook state before retrying",
			message: "repository rook state is invalid",
		},
	);
	const origin = await attempt(() => getRemoteUrl(cwd, "origin", dependencies), {
		stage: "validate-upstream",
		code: "origin-missing",
		remediation: "git remote add origin <upstream-repo-url>",
		message: "the current clone has no readable origin remote",
	});
	if (origin === undefined) {
		throw new RookError("the current clone has no origin remote", {
			stage: "validate-upstream",
			code: "origin-missing",
			remediation: "git remote add origin <upstream-repo-url>",
		});
	}
	const upstreamIdentity = await attempt(() => normalizeRepoIdentity(upstream), {
		stage: "validate-upstream",
		code: "upstream-url-invalid",
		remediation: "use a credential-free URL for the current clone's origin",
		message: "upstream repository URL is invalid",
	});
	const originIdentity = await attempt(() => normalizeRepoIdentity(origin), {
		stage: "validate-upstream",
		code: "upstream-url-invalid",
		remediation: "replace origin with a credential-free repository URL",
		message: "origin repository URL is invalid",
	});
	if (upstreamIdentity !== originIdentity) {
		throw new RookError("upstream repository does not match this clone's origin", {
			stage: "validate-upstream",
			code: "upstream-origin-mismatch",
			remediation: "run rook fork with the current clone's origin repository",
		});
	}
	if (state) {
		let stateIdentity;
		try {
			stateIdentity = normalizeRepoIdentity(state.upstreamUrl);
		} catch {
			stateIdentity = undefined;
		}
		if (stateIdentity !== upstreamIdentity) {
			throw new RookError("repository rook state belongs to a different upstream", {
				stage: "validate-upstream",
				code: "state-conflict",
				remediation: "run rook fork in the clone that owns this repository state",
			});
		}
		const rookRemote = await attempt(() => getRemoteUrl(cwd, "rook", dependencies), {
			stage: "validate-upstream",
			code: "remote-conflict",
			remediation: "verify or remove the conflicting rook remote before retrying",
			message: "rook remote could not be validated",
		});
		if (rookRemote !== undefined && rookRemote !== state.rookRemoteUrl) {
			throw new RookError("rook remote does not match repository state", {
				stage: "validate-upstream",
				code: "remote-conflict",
				remediation: "verify or remove the conflicting rook remote before retrying",
			});
		}
	}

	let identityPath;
	try {
		identityPath = resolveIdentityPath(options, dependencies.env, cwd);
	} catch {
		throw new RookError("selected identity path is invalid", {
			stage: "validate-upstream",
			code: "identity-invalid",
			remediation: "select a valid enrolled identity",
		});
	}
	const identity = await attempt(() => (dependencies.readIdentity ?? readIdentity)(identityPath), {
		stage: "validate-upstream",
		code: "identity-invalid",
		remediation: "run rook enroll --invite <url> --handle <name>",
		message: "selected identity is invalid",
	});
	if (!identity) {
		throw new RookError("no enrolled identity is available", {
			stage: "validate-upstream",
			code: "identity-invalid",
			remediation: "run rook enroll --invite <url> --handle <name>",
		});
	}
	const context =
		providedContext ??
		(await (dependencies.restoreContext ?? restoreContext)(identity, identityPath, dependencies));
	const knot = context.knot;
	if (state && !sameKnotHost(state, knot)) {
		if (!providedContext) await context.transaction.rollback().catch(() => {});
		throw new RookError("repository rook state belongs to a different knot", {
			stage: "validate-upstream",
			code: "state-conflict",
			remediation: "run rook fork with the identity that owns this repository state",
		});
	}
	if (!providedContext) {
		let promoted = false;
		try {
			await context.transaction.promote();
			promoted = true;
		} catch (error) {
			throw failure(error, {
				stage: "session",
				code: "session-invalid",
				remediation: "run rook login",
				message: error instanceof RookError ? undefined : "OAuth session could not be promoted",
			});
		} finally {
			if (!promoted) await context.transaction.rollback().catch(() => {});
		}
	}
	const session = context.session;

	const canonicalSource = await attempt(() => canonicalRepoSource(upstream), {
		stage: "derive",
		code: "upstream-url-invalid",
		remediation: "use a valid credential-free upstream repository URL",
		message: "upstream repository source cannot be derived",
	});
	const name = await attempt(() => deriveKnotRepoName(upstreamIdentity), {
		stage: "derive",
		code: "upstream-url-invalid",
		remediation: "use an upstream whose repository name is valid for Tangled",
		message: "upstream repository name is invalid for Tangled",
	});
	if (state && state.knotRepoName !== name) {
		throw new RookError("repository rook state has a different knot repository name", {
			stage: "derive",
			code: "state-conflict",
			remediation: "run rook fork in the clone that owns this repository state",
		});
	}
	const preflightRecord = await attempt(
		() =>
			(dependencies.readRepoRecord ?? readRepoRecord)(
				session,
				{ repo: identity.did, rkey: name },
				dependencies,
			),
		{
			stage: "derive",
			code: "repo-record-rejected",
			remediation: RETRY_FORK,
			message: "could not preflight the repository record",
		},
	);
	let expectedRepoDid = state?.knotRepoDid;
	if (preflightRecord) {
		const preflightRepoDid = recordDid(preflightRecord, knot);
		if (
			!recordPreflightMatches(preflightRecord, knot, upstreamIdentity, name) ||
			!preflightRepoDid
		) {
			throw new RookError("existing repository record has conflicting provenance", {
				stage: "derive",
				code: "repo-record-conflict",
				remediation: "resolve the existing sh.tangled.repo record before retrying",
			});
		}
		if (expectedRepoDid && expectedRepoDid !== preflightRepoDid) {
			throw new RookError("repository state and record identify different knot repositories", {
				stage: "derive",
				code: "state-conflict",
				remediation: "repair the conflicting repository provenance before retrying",
			});
		}
		expectedRepoDid = preflightRepoDid;
	}

	await attempt(() => resolveCommit(cwd, "HEAD", dependencies), {
		stage: "default-branch",
		code: "head-unborn",
		remediation: "make an initial commit or check out a branch with commits",
		message: "HEAD has no commit",
	});
	const defaultBranch = await attempt(() => remoteHeadBranch(cwd, "origin", dependencies), {
		stage: "default-branch",
		code: "default-branch-missing",
		remediation: "git fetch origin && git remote set-head origin -a",
		message: "origin default branch is unavailable",
	});
	if (defaultBranch === undefined) {
		throw new RookError("origin default branch is unavailable", {
			stage: "default-branch",
			code: "default-branch-missing",
			remediation: "git fetch origin && git remote set-head origin -a",
		});
	}
	await attempt(() => resolveCommit(cwd, `refs/remotes/origin/${defaultBranch}`, dependencies), {
		stage: "default-branch",
		code: "default-branch-ref-missing",
		forceCode: true,
		remediation: "git fetch origin",
		message: "origin default branch ref has no commit",
	});

	let token;
	try {
		token = await (dependencies.mintServiceAuth ?? mintServiceAuth)(
			session,
			{
				serviceOrigin: identity.serviceOrigin,
				aud: knot.aud,
				lxm: "sh.tangled.repo.create",
			},
			dependencies,
		);
	} catch (error) {
		throw failure(error, {
			stage: "repo-create",
			code:
				error?.code === "service-auth-rejected" ? "service-auth-rejected" : "repo-create-rejected",
			forceCode: true,
			remediation: error?.code === "service-auth-rejected" ? "run rook login" : RETRY_FORK,
			message: "could not mint knot repository authorization",
		});
	}
	let created;
	try {
		created = await (dependencies.createKnotRepo ?? createKnotRepo)(
			knot,
			{ token, rkey: name, name, defaultBranch, source: canonicalSource },
			dependencies,
		);
	} catch (error) {
		throw failure(error, {
			stage: "repo-create",
			code: error?.code ?? "repo-create-rejected",
			remediation: RETRY_FORK,
			message: error instanceof RookError ? undefined : "knot repository request failed",
		});
	}
	const repoDid = created?.repoDid;
	let rookRemoteUrl;
	try {
		rookRemoteUrl = deriveRepoUrl(knot.host, repoDid);
	} catch {
		throw new RookError("knot repository response has an invalid repository DID", {
			stage: "repo-create",
			code: "repo-create-invalid-response",
			remediation: RETRY_FORK,
		});
	}
	if (expectedRepoDid && repoDid !== expectedRepoDid) {
		throw new RookError("knot repository does not match existing provenance", {
			stage: "repo-create",
			code: "state-conflict",
			remediation: "repair the conflicting repository provenance before retrying",
		});
	}
	const knotOutcome = expectedRepoDid ? "adopted" : null;

	const expectedRecord = recordExpected(knot, repoDid, canonicalSource, name);
	let record = await attempt(
		() =>
			(dependencies.readRepoRecord ?? readRepoRecord)(
				session,
				{ repo: identity.did, rkey: name },
				dependencies,
			),
		{
			stage: "repo-record",
			code: "repo-record-rejected",
			remediation: RETRY_FORK,
			message: "could not read the repository record",
		},
	);
	let recordOutcome;
	if (record) {
		if (!repoRecordMatches(record, expectedRecord)) {
			throw new RookError("existing repository record has conflicting provenance", {
				stage: "repo-record",
				code: "repo-record-conflict",
				remediation: "resolve the existing sh.tangled.repo record before retrying",
			});
		}
		recordOutcome = "adopted";
	} else {
		let createdAt;
		try {
			createdAt = new Date(dependencies.clock?.() ?? Date.now()).toISOString();
		} catch {
			throw new RookError("repository record creation time is invalid", {
				stage: "repo-record",
				code: "repo-record-rejected",
				remediation: RETRY_FORK,
			});
		}
		const recordValue = { ...expectedRecord, createdAt };
		try {
			await (dependencies.createRepoRecord ?? createRepoRecord)(
				session,
				{ repo: identity.did, rkey: name, record: recordValue },
				dependencies,
			);
			recordOutcome = "created";
		} catch (error) {
			if (error?.code !== "repo-record-conflict") {
				throw failure(error, {
					stage: "repo-record",
					code: error?.code ?? "repo-record-rejected",
					remediation: RETRY_FORK,
					message: error instanceof RookError ? undefined : "repository record create failed",
				});
			}
			record = await attempt(
				() =>
					(dependencies.readRepoRecord ?? readRepoRecord)(
						session,
						{ repo: identity.did, rkey: name },
						dependencies,
					),
				{
					stage: "repo-record",
					code: "repo-record-rejected",
					remediation: RETRY_FORK,
					message: "could not verify the raced repository record",
				},
			);
			if (!record || !repoRecordMatches(record, expectedRecord)) {
				throw new RookError("raced repository record has conflicting provenance", {
					stage: "repo-record",
					code: "repo-record-conflict",
					remediation: "resolve the existing sh.tangled.repo record before retrying",
				});
			}
			recordOutcome = "adopted";
		}
	}

	// On a first fork there is no repo DID in state, so an existing remote can only be
	// resolved against the derived URL after the knot create-or-adopt response.
	let remote;
	try {
		remote = await (dependencies.ensureRemoteUrl ?? ensureRemoteUrl)(
			cwd,
			"rook",
			rookRemoteUrl,
			dependencies,
		);
	} catch (error) {
		throw failure(error, {
			stage: "remote",
			code: error?.code === "remote-conflict" ? "remote-conflict" : "remote-update-failed",
			remediation:
				error?.code === "remote-conflict"
					? "verify or remove the conflicting rook remote before retrying"
					: RETRY_FORK,
			message: error instanceof RookError ? undefined : "could not configure the rook remote",
		});
	}

	await attempt(
		() =>
			(dependencies.writeRepoState ?? writeRepoState)(
				gitCommonDir,
				{
					upstreamUrl: canonicalSource,
					upstreamDefaultBranch: defaultBranch,
					knotRepoName: name,
					knotRepoDid: repoDid,
					rookRemoteUrl,
				},
				dependencies,
			),
		{
			stage: "persist",
			code: "state-write-failed",
			forceCode: true,
			remediation: RETRY_FORK,
			message: "could not persist repository rook state",
		},
	);

	return {
		upstreamUrl: canonicalSource,
		upstreamDefaultBranch: defaultBranch,
		knotRepoName: name,
		knotRepoDid: repoDid,
		rookRemoteUrl,
		knot: { outcome: knotOutcome },
		record: { outcome: recordOutcome },
		remote: { outcome: remote.outcome },
	};
}

export function fork(options, dependencies = {}) {
	return forkCore(options, null, dependencies);
}

export function register(program, dependencies = {}) {
	program
		.command("fork")
		.description("create or adopt the rook-owned knot repo for this clone")
		.argument("<upstream-repo-url>")
		.option("--json", "emit structured JSON")
		.action(async (upstreamRepoUrl, localOptions, command) => {
			const output = createOutput({ ...dependencies, json: localOptions.json });
			try {
				const result = await fork({ ...command.optsWithGlobals(), upstreamRepoUrl }, dependencies);
				const knotOutcome = result.knot.outcome ?? "outcome unknown";
				output.success(
					result,
					[
						`forked ${result.upstreamUrl}`,
						`knot repo ${result.knotRepoDid} ${knotOutcome}`,
						`record ${result.record.outcome}`,
						`remote ${result.remote.outcome}`,
					].join("\n"),
				);
			} catch (error) {
				output.failure(error);
				process.exitCode = 1;
			}
		});
}
