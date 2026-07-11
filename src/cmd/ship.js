// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import {
	capMatches,
	capUnchanged,
	deriveBeacon,
	listCapRecords,
	publishOrRefreshCap,
	resolveRequestCap,
} from "../lib/cap.js";
import { RookError } from "../lib/error-format.js";
import { normalizeRepoIdentity, resolveGitCommonDir } from "../lib/git.js";
import { readIdentity } from "../lib/identity.js";
import { createOutput } from "../lib/json-output.js";
import { resolveIdentityPath } from "../lib/paths.js";
import { readRepoState, writeRepoState } from "../lib/repo-state.js";
import { restoreContext } from "../lib/session-context.js";

const RETRY_SHIP = "run rook ship";
const REF_PATTERN = /^[a-z]+-[a-z]+-[a-z]+$/;
const VALID_KINDS = new Set([
	"feat",
	"fix",
	"test",
	"docs",
	"refactor",
	"chore",
	"perf",
	"style",
	"request",
]);

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
	return new Date(dependencies.clock?.() ?? Date.now()).toISOString();
}

// A stable, valid, letters-only default ref seeded by the pull URI. Because it
// lives in record.ref it survives refreshes and total state loss, unlike a
// cid-derived ref. Overridable with --ref within vit's pattern.
function defaultCapRef(seed) {
	const digest = createHash("sha256").update(seed).digest();
	const word = (start, length) => {
		let out = "";
		for (let index = 0; index < length; index += 1) {
			out += String.fromCharCode(97 + (digest[start + index] % 26));
		}
		return out;
	};
	return `rook-${word(0, 6)}-${word(6, 6)}`;
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

export async function shipCore(options, providedContext, dependencies = {}) {
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
	if (!state.pullUri || !state.renderedPullUrl) {
		throw new RookError("no verified rendered pull URL is recorded", {
			stage: "gate",
			code: "rendered-url-missing",
			remediation: "run rook pr",
		});
	}

	if (options.ref !== undefined && !REF_PATTERN.test(options.ref)) {
		throw new RookError("--ref must be three lowercase words separated by dashes", {
			stage: "gate",
			code: "cap-ref-invalid",
			remediation: "pass a ref like fast-cache-invalidation",
		});
	}
	if (options.kind !== undefined && !VALID_KINDS.has(options.kind)) {
		throw new RookError(`--kind must be one of: ${[...VALID_KINDS].join(", ")}`, {
			stage: "gate",
			code: "cap-kind-invalid",
			remediation: "pass a supported cap kind",
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
	const renderedPullUrl = state.renderedPullUrl;
	const beacon = await attempt(() => deriveBeacon(state.upstreamUrl), {
		stage: "cap",
		code: "beacon-invalid",
		remediation: "run rook fork <upstream-repo-url>",
		message: "could not derive the upstream beacon",
	});
	const title = options.title ?? `${state.lastPushedBranch} → ${state.upstreamDefaultBranch}`;
	const description =
		options.description ?? `rook pull for ${normalizeRepoIdentity(state.upstreamUrl)}`;
	const text = options.body ?? "";
	const kind = options.kind ?? "feat";
	const embedExternal = { uri: renderedPullUrl, title, description };

	let reply;
	let requestParentUri;
	if (options.request !== undefined) {
		const refs = await attempt(() => resolveRequestCap(options.request, dependencies), {
			stage: "request",
			code: "request-cap-unresolved",
			remediation: "verify the --request cap exists and is reachable",
			message: "could not resolve the request cap",
		});
		reply = { root: refs.root, parent: refs.parent };
		requestParentUri = refs.parent.uri;
	}

	const desired = { embedExternal, title, description, text, kind, reply };

	const all = await attempt(() => listCapRecords(agent, rookDid, dependencies), {
		stage: "cap",
		code: "cap-list-failed",
		remediation: RETRY_SHIP,
		message: "could not list existing caps",
	});
	const matches = all.filter((record) =>
		capMatches(record.value, { renderedPullUrl, beacon, requestParentUri }),
	);
	if (matches.length > 1) {
		throw new RookError("multiple caps match this pull", {
			stage: "cap",
			code: "cap-ambiguous",
			remediation: "resolve the duplicate org.v-it.cap records before retrying",
		});
	}
	const existing = matches.length === 1 ? matches[0] : null;

	let cap;
	if (existing) {
		const rkey = rkeyFromUri(existing.uri);
		const isStored = state.capUri === existing.uri;
		const knownRef =
			isStored && state.capRef
				? state.capRef
				: REF_PATTERN.test(existing.value.ref ?? "")
					? existing.value.ref
					: undefined;
		const createdAt =
			isStored && state.capCreatedAt ? state.capCreatedAt : existing.value.createdAt;
		if (knownRef && capUnchanged(existing.value, desired)) {
			cap = {
				uri: existing.uri,
				rkey,
				cid: existing.cid,
				capRef: knownRef,
				createdAt,
				outcome: "adopted",
			};
		} else {
			cap = await attempt(
				() =>
					publishOrRefreshCap(
						agent,
						{
							repo: rookDid,
							existing: { rkey, cid: existing.cid, capRef: knownRef, createdAt },
							title,
							description,
							text,
							beacon,
							embedExternal,
							reply,
							kind,
						},
						dependencies,
					),
				{
					stage: "cap",
					code: "cap-rejected",
					remediation: RETRY_SHIP,
					message: "cap refresh failed",
				},
			);
		}
	} else {
		const createRef = options.ref ?? defaultCapRef(state.pullUri);
		cap = await attempt(
			() =>
				publishOrRefreshCap(
					agent,
					{
						repo: rookDid,
						title,
						description,
						text,
						ref: createRef,
						beacon,
						embedExternal,
						reply,
						kind,
						createdAt: nowIso(dependencies),
					},
					dependencies,
				),
			{ stage: "cap", code: "cap-rejected", remediation: RETRY_SHIP, message: "cap create failed" },
		);
	}

	// State only after the durable cap write (or confirmed adoption).
	await attempt(
		() =>
			(dependencies.writeRepoState ?? writeRepoState)(
				gitCommonDir,
				{
					capUri: cap.uri,
					capRkey: cap.rkey,
					capCid: cap.cid,
					capRef: cap.capRef,
					capCreatedAt: cap.createdAt,
				},
				dependencies,
			),
		{
			stage: "persist",
			code: "state-write-failed",
			forceCode: true,
			remediation: RETRY_SHIP,
			message: "could not persist the cap identity",
		},
	);

	return {
		outcome: cap.outcome,
		capUri: cap.uri,
		capRef: cap.capRef,
		capCid: cap.cid,
		renderedPullUrl,
		beacon,
	};
}

export function ship(options, dependencies = {}) {
	return shipCore(options, null, dependencies);
}

export function register(program, dependencies = {}) {
	program
		.command("ship")
		.description("create or refresh the canonical vit cap for the rendered pull")
		.option("--request <cap-uri>", "reply to a request cap at this org.v-it.cap URI")
		.option("--title <title>", "override the derived cap title")
		.option("--description <description>", "override the derived cap description")
		.option("--body <body>", "cap body text")
		.option("--ref <ref>", "three lowercase words with dashes; defaults from the pull")
		.option(
			"--kind <kind>",
			"cap kind (feat, fix, test, docs, refactor, chore, perf, style, request)",
		)
		.option("--json", "emit structured JSON")
		.action(async (localOptions, command) => {
			const output = createOutput({ ...dependencies, json: localOptions.json });
			try {
				const result = await ship({ ...command.optsWithGlobals(), ...localOptions }, dependencies);
				output.success(
					result,
					[
						`cap ${result.outcome} ${result.capUri}`,
						`ref ${result.capRef}`,
						`pull ${result.renderedPullUrl}`,
					].join("\n"),
				);
			} catch (error) {
				output.failure(error);
				process.exitCode = 1;
			}
		});
}
