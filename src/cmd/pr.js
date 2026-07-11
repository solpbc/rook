// SPDX-License-Identifier: AGPL-3.0-only

import { RookError } from "../lib/error-format.js";
import { normalizeRepoIdentity, resolveCommit, resolveGitCommonDir } from "../lib/git.js";
import { readIdentity } from "../lib/identity.js";
import { createOutput } from "../lib/json-output.js";
import { formatPatch } from "../lib/patch.js";
import { resolveIdentityPath } from "../lib/paths.js";
import {
	appendPullRound,
	buildPullRecord,
	createPullRecord,
	listPullRecords,
	nextRkey,
	pullMatchesTuple,
	uploadPatchBlob,
} from "../lib/pull.js";
import { DEFAULT_APPVIEW_ORIGIN, resolveRenderedPullUrl } from "../lib/rendered-url.js";
import { readRepoState, writeRepoState } from "../lib/repo-state.js";
import { restoreContext } from "../lib/session-context.js";

const RETRY_PR = "run rook pr";

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

function sameKnotHost(state, knot) {
	try {
		return new URL(state.rookRemoteUrl).host.toLowerCase() === knot.host.toLowerCase();
	} catch {
		return false;
	}
}

function rkeyFromUri(uri) {
	return uri.slice(uri.lastIndexOf("/") + 1);
}

function nowIso(dependencies) {
	try {
		return new Date(dependencies.clock?.() ?? Date.now()).toISOString();
	} catch {
		throw new RookError("pull record time is invalid", {
			stage: "pull",
			code: "pull-time-invalid",
		});
	}
}

async function promoteStandalone(context) {
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

// Find the one self-pull matching the full effective tuple across every page.
// A stored pull is reused only through this same tuple match, so a pull whose
// record no longer matches is preserved. More than one match fails without a write.
async function discoverPull(agent, rookDid, wanted, dependencies) {
	const all = await attempt(() => listPullRecords(agent, rookDid, dependencies), {
		stage: "pull",
		code: "pull-list-failed",
		remediation: RETRY_PR,
		message: "could not list existing pull records",
	});
	const matches = all.filter((record) => pullMatchesTuple(record.value, wanted));
	if (matches.length > 1) {
		throw new RookError("multiple pull records match this self-pull", {
			stage: "pull",
			code: "pull-ambiguous",
			remediation: "resolve the duplicate sh.tangled.repo.pull records before retrying",
		});
	}
	if (matches.length === 1) {
		const match = matches[0];
		return { uri: match.uri, rkey: rkeyFromUri(match.uri), cid: match.cid, value: match.value };
	}
	return null;
}

export async function prCore(options, providedContext, dependencies = {}) {
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
	if (!state.lastPushedBranch || !state.lastPushedTip) {
		throw new RookError("no pushed branch is recorded for this rook", {
			stage: "gate",
			code: "push-proof-missing",
			remediation: "run rook push",
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

	const context =
		providedContext ??
		(await (dependencies.restoreContext ?? restoreContext)(identity, identityPath, dependencies));
	const agent = context.agent;
	const rollbackOwn = async () => {
		if (!providedContext) await context.transaction.rollback().catch(() => {});
	};
	if (!sameKnotHost(state, context.knot)) {
		await rollbackOwn();
		throw new RookError("repository state belongs to a different knot", {
			stage: "session",
			code: "state-conflict",
			remediation: "run rook fork <upstream-repo-url>",
		});
	}
	if (agent.did !== identity.did) {
		await rollbackOwn();
		throw new RookError("restored agent does not match the selected identity", {
			stage: "session",
			code: "session-identity-mismatch",
			remediation: "run rook login",
		});
	}
	if (!providedContext) await promoteStandalone(context);

	const rookDid = identity.did;
	const knotRepoDid = state.knotRepoDid;
	const targetBranch = state.upstreamDefaultBranch;
	const sourceBranch = state.lastPushedBranch;
	const tip = state.lastPushedTip;
	const wanted = { sourceDid: knotRepoDid, sourceBranch, targetDid: knotRepoDid, targetBranch };

	const base = await attempt(
		() => resolveCommit(cwd, `refs/remotes/origin/${targetBranch}`, dependencies),
		{
			stage: "range",
			code: "base-ref-missing",
			forceCode: true,
			remediation: "git fetch origin; rerun rook fork if the default branch moved",
			message: "stored upstream default branch ref is missing",
		},
	);

	const existing = await discoverPull(agent, rookDid, wanted, dependencies);
	if (!existing && options.update === true) {
		throw new RookError("no existing pull to update", {
			stage: "pull",
			code: "pull-missing",
			remediation: "run rook pr to open the pull first",
		});
	}
	// --update always appends a fresh round on demand. submit's automatic append
	// only fires when the pushed tip advanced past the last recorded round, so
	// re-running submit after a transient later-stage failure adopts instead of
	// stacking an identical round.
	let append = false;
	if (existing) {
		if (options.update === true) append = true;
		else if (options.appendWhenExists === true) append = state.pullRoundTip !== tip;
	}

	let pull;
	let outcome;
	if (existing && !append) {
		pull = {
			uri: existing.uri,
			rkey: existing.rkey,
			cid: existing.cid,
			createdAt: existing.value.createdAt,
		};
		outcome = "adopted";
	} else {
		// A fresh round demands the deterministic outgoing patch; an empty range
		// fails here, before any blob upload.
		const patchBytes = await attempt(() => formatPatch(cwd, base, tip, dependencies), {
			stage: "range",
			code: "outgoing-range-empty",
			remediation: "push commits on this branch before opening a pull",
			message: "outgoing patch could not be built",
		});
		const blob = await attempt(() => uploadPatchBlob(agent, patchBytes, dependencies), {
			stage: "pull",
			code: "pull-blob-rejected",
			remediation: RETRY_PR,
			message: "patch blob upload failed",
		});
		const round = { createdAt: nowIso(dependencies), patchBlob: blob };
		if (existing) {
			const priorRecord = { ...existing.value };
			if (options.title) priorRecord.title = options.title;
			if (options.body !== undefined) priorRecord.body = options.body;
			const result = await attempt(
				() =>
					appendPullRound(
						agent,
						{ repo: rookDid, rkey: existing.rkey, priorRecord, round, swapCid: existing.cid },
						dependencies,
					),
				{
					stage: "pull",
					code: "pull-record-rejected",
					remediation: RETRY_PR,
					message: "pull round append failed",
				},
			);
			pull = {
				uri: result.uri,
				rkey: existing.rkey,
				cid: result.cid,
				createdAt: existing.value.createdAt,
			};
			outcome = "refreshed";
		} else {
			const createdAt = nowIso(dependencies);
			const record = buildPullRecord({
				title: options.title ?? `${sourceBranch} → ${targetBranch}`,
				body: options.body ?? `rook pull for ${normalizeRepoIdentity(state.upstreamUrl)}`,
				targetDid: knotRepoDid,
				targetBranch,
				sourceBranch,
				rounds: [round],
				createdAt,
			});
			const rkey = (dependencies.newRkey ?? nextRkey)();
			const result = await attempt(
				() => createPullRecord(agent, { repo: rookDid, rkey, record }, dependencies),
				{
					stage: "pull",
					code: "pull-record-rejected",
					remediation: RETRY_PR,
					message: "pull record create failed",
				},
			);
			pull = { uri: result.uri, rkey, cid: result.cid, createdAt };
			outcome = "created";
		}
	}

	// State only after the durable pull write (or confirmed adoption). A created
	// or refreshed round records the tip it covers so submit stays idempotent;
	// adoption leaves any existing round tip untouched.
	await attempt(
		() =>
			(dependencies.writeRepoState ?? writeRepoState)(
				gitCommonDir,
				{
					pullUri: pull.uri,
					pullRkey: pull.rkey,
					pullCid: pull.cid,
					pullCreatedAt: pull.createdAt,
					...(outcome === "adopted" ? {} : { pullRoundTip: tip }),
				},
				dependencies,
			),
		{
			stage: "persist",
			code: "state-write-failed",
			forceCode: true,
			remediation: RETRY_PR,
			message: "could not persist the pull record identity",
		},
	);

	const appviewOrigin = dependencies.appviewOrigin ?? DEFAULT_APPVIEW_ORIGIN;
	const owner = rookDid;
	const repoSlug = state.knotRepoName;
	let renderedPullUrl;
	try {
		renderedPullUrl = await resolveRenderedPullUrl(
			pull.uri,
			{ appviewOrigin, owner, repoSlug },
			dependencies,
		);
	} catch (error) {
		const listUrl = `${appviewOrigin.replace(/\/+$/, "")}/${owner}/${repoSlug}/pulls`;
		throw new RookError("pull exists but its rendered URL has not converged", {
			stage: "rendered-url",
			code: "rendered-url-unresolved",
			remediation: "run rook pr again once the pull is indexed",
			hint: `pull ${pull.uri}; pulls list ${listUrl}`,
			cause: error instanceof RookError ? error.cause : error,
		});
	}

	await attempt(
		() =>
			(dependencies.writeRepoState ?? writeRepoState)(
				gitCommonDir,
				{ renderedPullUrl },
				dependencies,
			),
		{
			stage: "persist",
			code: "state-write-failed",
			forceCode: true,
			remediation: RETRY_PR,
			message: "could not persist the rendered pull URL",
		},
	);

	return {
		outcome,
		pullUri: pull.uri,
		pullRkey: pull.rkey,
		pullCid: pull.cid,
		renderedPullUrl,
		knotRepoDid,
		sourceBranch,
		targetBranch,
	};
}

export function pr(options, dependencies = {}) {
	return prCore(options, null, dependencies);
}

export function register(program, dependencies = {}) {
	program
		.command("pr")
		.description("create or refresh the rook self-pull for the last pushed branch")
		.option("--update", "append a fresh round to the existing pull")
		.option("--title <title>", "override the derived pull title")
		.option("--body <body>", "override the derived pull body")
		.option("--json", "emit structured JSON")
		.action(async (localOptions, command) => {
			const output = createOutput({ ...dependencies, json: localOptions.json });
			try {
				const result = await pr({ ...command.optsWithGlobals(), ...localOptions }, dependencies);
				output.success(
					result,
					[`pull ${result.outcome} ${result.renderedPullUrl}`, `record ${result.pullUri}`].join(
						"\n",
					),
				);
			} catch (error) {
				output.failure(error);
				process.exitCode = 1;
			}
		});
}
