// SPDX-License-Identifier: AGPL-3.0-only

import { verifyHandleDid } from "../lib/discovery.js";
import { RookError } from "../lib/error-format.js";
import {
	buildGitAuthEnv,
	currentBranch,
	enumerateProvenance,
	getRemoteUrl,
	lsRemoteRef,
	resolveCommit,
	resolveGitCommonDir,
} from "../lib/git.js";
import { readIdentity } from "../lib/identity.js";
import { createOutput } from "../lib/json-output.js";
import { deriveKnotTarget, listKnotMembers } from "../lib/knot.js";
import { fetchClientMetadata, missingScopes, rpcScopes, tokenInfoFields } from "../lib/oauth.js";
import { deriveIdentityPaths, resolveIdentityPath } from "../lib/paths.js";
import { findProvenanceOffenders, provenanceRepairSteps } from "../lib/provenance.js";
import { readRepoState } from "../lib/repo-state.js";
import { mintServiceAuth } from "../lib/service-auth.js";
import { restoreSession } from "../lib/session.js";
import { fileExists, fileMode } from "../lib/storage.js";
import { receivePackAdvertisement } from "../lib/tangled.js";

const SERVICE_AUTH_CHECKS = [
	["service-auth-repo-create", "sh.tangled.repo.create"],
	["service-auth-receive-pack", "sh.tangled.git.receivePack"],
];

function check(name, status, detail, recovery) {
	return { name, status, detail, ...(recovery ? { recovery } : {}) };
}

function shellQuote(value) {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function overall(checks) {
	if (checks.some(({ status }) => status === "fail")) {
		return {
			status: "fail",
			verdict: "identity, authentication, or repository diagnostics failed",
		};
	}
	if (checks.some(({ status }) => status === "degraded")) {
		return {
			status: "degraded",
			verdict: "identity, authentication, or repository diagnostics are degraded",
		};
	}
	if (checks.some(({ status }) => status === "not_checked")) {
		return {
			status: "not_checked",
			verdict: "identity, authentication, or repository diagnostics are incomplete",
		};
	}
	return { status: "ok", verdict: "identity, authentication, and repository push checks passed" };
}

async function inspectPermissions(paths, dependencies) {
	const broad = [];
	for (const filePath of [paths.identityPath, paths.sessionPath, paths.statePath]) {
		const mode = await fileMode(filePath, dependencies.fs);
		if (mode !== undefined && mode !== 0o600) broad.push({ filePath, mode });
	}
	if (broad.length === 0)
		return check("secret-permissions", "ok", "all existing secret files are mode 0600");
	return check(
		"secret-permissions",
		"degraded",
		broad.map(({ filePath, mode }) => `${filePath} is mode ${mode.toString(8)}`).join("; "),
		broad.map(({ filePath }) => `chmod 600 -- ${shellQuote(filePath)}`).join(" && "),
	);
}

async function serviceAuthCheck(name, nsid, context, dependencies) {
	if (!context.session || !context.knot)
		return { result: check(name, "not_checked", "prerequisites were not earned") };
	const expected = rpcScopes(context.metadata.scope).find(
		(entry) => entry.nsid === nsid && entry.aud === context.knot.aud,
	)?.token;
	if (!expected)
		return {
			result: check(
				name,
				"fail",
				`served client metadata is missing the ${nsid} RPC scope`,
				"run rook login",
			),
		};
	try {
		const token = await (dependencies.mintServiceAuth ?? mintServiceAuth)(
			context.session,
			{
				serviceOrigin: context.identity.serviceOrigin,
				aud: context.knot.aud,
				lxm: nsid,
			},
			dependencies,
		);
		return {
			result: check(name, "ok", `service authorization for ${nsid} can be minted read-only`),
			token,
		};
	} catch (error) {
		if (error?.code === "service-auth-rejected") {
			return {
				result:
					error.message === "OAuth session was rejected"
						? check(name, "fail", "OAuth session was rejected", "run rook login")
						: check(name, "fail", `missing required scope ${expected}`, "run rook login"),
			};
		}
		return { result: check(name, "degraded", "could not mint service authorization") };
	}
}

function sameKnotHost(state, knot) {
	try {
		return new URL(state.rookRemoteUrl).host.toLowerCase() === knot.host.toLowerCase();
	} catch {
		return false;
	}
}

async function repositoryChecks(context, dependencies) {
	const checks = [];
	const cwd = dependencies.cwd ?? process.cwd();
	let gitCommonDir;
	try {
		gitCommonDir = await resolveGitCommonDir(cwd, dependencies);
	} catch {
		checks.push(
			check(
				"repository-state",
				"not_checked",
				"current directory is not a configured Git repository",
				"run rook fork <upstream-repo-url> inside a git clone",
			),
		);
	}
	let state;
	if (gitCommonDir) {
		try {
			state = await (dependencies.readRepoState ?? readRepoState)(gitCommonDir, dependencies);
			checks.push(
				state
					? check("repository-state", "ok", "worktree-shared repository state is valid")
					: check(
							"repository-state",
							"not_checked",
							"repository has not been configured for this rook",
							"run rook fork <upstream-repo-url>",
						),
			);
		} catch {
			checks.push(
				check(
					"repository-state",
					"fail",
					"repository rook state is invalid",
					"repair the repository rook state before retrying",
				),
			);
		}
	}

	let remoteReady = false;
	if (!state) {
		checks.push(
			check("rook-remote", "not_checked", "repository state prerequisite was not earned"),
		);
	} else {
		try {
			const remote = await getRemoteUrl(cwd, "rook", dependencies);
			remoteReady = remote === state.rookRemoteUrl;
			checks.push(
				remoteReady
					? check("rook-remote", "ok", "rook remote matches repository state")
					: check(
							"rook-remote",
							"fail",
							"rook remote is missing or points at another repository",
							"run rook fork <upstream-repo-url>",
						),
			);
		} catch {
			checks.push(
				check(
					"rook-remote",
					"fail",
					"rook remote could not be validated",
					"run rook fork <upstream-repo-url>",
				),
			);
		}
	}

	let branch;
	let tip;
	let provenanceReady = false;
	if (!state || !context.identity) {
		checks.push(
			check(
				"branch-provenance",
				"not_checked",
				"repository state or identity prerequisite was not earned",
			),
		);
	} else {
		try {
			branch = await currentBranch(cwd, dependencies);
			if (!branch) throw new Error("detached");
			tip = await resolveCommit(cwd, `refs/heads/${branch}`, dependencies);
			const base = await resolveCommit(
				cwd,
				`refs/remotes/origin/${state.upstreamDefaultBranch}`,
				dependencies,
			);
			const provenance = await enumerateProvenance(cwd, base, tip, dependencies);
			const offenders = findProvenanceOffenders(provenance, context.identity.did);
			if (offenders.length > 0) {
				const detail = offenders
					.map(
						({ hash, authorEmail, committerEmail }) =>
							`${hash}: author=${authorEmail}; committer=${committerEmail}`,
					)
					.join("; ");
				checks.push(
					check(
						"branch-provenance",
						"fail",
						`outgoing commits lack exact rook DID provenance: ${detail}`,
						provenanceRepairSteps(context.identity.did, base),
					),
				);
			} else {
				provenanceReady = true;
				checks.push(
					check(
						"branch-provenance",
						"ok",
						"every outgoing author and committer email matches the rook DID",
					),
				);
			}
		} catch {
			checks.push(
				check(
					"branch-provenance",
					"fail",
					"current branch, upstream base, or commit provenance could not be proven",
					"git fetch origin; switch to a branch and repair provenance before rerunning rook doctor",
				),
			);
		}
	}

	const receiveAuth = context.receiveAuth;
	const knotHostConflict = Boolean(state && context.knot && !sameKnotHost(state, context.knot));
	if (!state) {
		checks.push(
			check(
				"receive-pack-advertisement",
				"not_checked",
				"repository state prerequisite was not earned",
			),
		);
	} else if (knotHostConflict) {
		checks.push(
			check(
				"receive-pack-advertisement",
				"fail",
				"repository state points at a different knot",
				"run rook fork <upstream-repo-url>",
			),
		);
	} else if (!remoteReady) {
		checks.push(
			check(
				"receive-pack-advertisement",
				"not_checked",
				"rook remote prerequisite was not earned",
				"run rook fork <upstream-repo-url>",
			),
		);
	} else if (!receiveAuth?.token) {
		checks.push(
			check(
				"receive-pack-advertisement",
				receiveAuth?.status === "degraded" ? "degraded" : "not_checked",
				"receive-pack authorization prerequisite was not earned",
				receiveAuth?.status === "degraded" ? "retry rook doctor" : undefined,
			),
		);
	} else {
		try {
			await (dependencies.receivePackAdvertisement ?? receivePackAdvertisement)(
				state.rookRemoteUrl,
				{ token: receiveAuth.token },
				dependencies,
			);
			checks.push(
				check(
					"receive-pack-advertisement",
					"ok",
					"authenticated receive-pack advertisement is available",
				),
			);
		} catch (error) {
			checks.push(
				check(
					"receive-pack-advertisement",
					error?.code === "receive-pack-rejected" ? "fail" : "degraded",
					error?.code === "receive-pack-rejected"
						? "receive-pack advertisement rejected the authenticated request"
						: "receive-pack advertisement is unavailable",
					error?.code === "receive-pack-rejected" ? "run rook login" : "retry rook doctor",
				),
			);
		}
	}

	if (!state) {
		checks.push(
			check(
				"repository-push-proof",
				"not_checked",
				"repository state prerequisite was not earned",
				"run rook push",
			),
		);
	} else if (knotHostConflict) {
		checks.push(
			check(
				"repository-push-proof",
				"fail",
				"repository state points at a different knot",
				"run rook fork <upstream-repo-url>",
			),
		);
	} else if (!branch || !tip || !provenanceReady) {
		checks.push(
			check(
				"repository-push-proof",
				"not_checked",
				"branch and state prerequisites were not earned",
				"run rook push",
			),
		);
	} else if (!state.lastPushedBranch || !state.lastPushedTip) {
		checks.push(
			check(
				"repository-push-proof",
				"not_checked",
				"no equality-proven push is saved for this repository",
				"run rook push",
			),
		);
	} else if (state.lastPushedBranch !== branch || state.lastPushedTip !== tip) {
		checks.push(
			check(
				"repository-push-proof",
				"fail",
				"saved push proof is stale for the current branch or tip",
				"run rook push",
			),
		);
	} else if (!remoteReady) {
		checks.push(
			check(
				"repository-push-proof",
				"not_checked",
				"rook remote prerequisite was not earned",
				"run rook fork <upstream-repo-url>",
			),
		);
	} else if (!receiveAuth?.token) {
		checks.push(
			check(
				"repository-push-proof",
				receiveAuth?.status === "degraded" ? "degraded" : "not_checked",
				"receive-pack authorization prerequisite was not earned",
				receiveAuth?.status === "degraded" ? "retry rook doctor" : "run rook push",
			),
		);
	} else {
		try {
			const authEnv = buildGitAuthEnv(
				state.rookRemoteUrl,
				receiveAuth.token,
				dependencies.env ?? process.env,
			);
			const remoteTip = await (dependencies.lsRemoteRef ?? lsRemoteRef)(
				cwd,
				"rook",
				`refs/heads/${branch}`,
				authEnv,
				dependencies,
			);
			checks.push(
				remoteTip === tip
					? check(
							"repository-push-proof",
							"ok",
							"saved push proof still equals the authenticated remote ref",
						)
					: check(
							"repository-push-proof",
							"fail",
							"authenticated remote tip differs from the current local tip",
							"run rook push",
						),
			);
		} catch (error) {
			const definitive = ["remote-ref-missing", "remote-ref-ambiguous"].includes(error?.code);
			checks.push(
				check(
					"repository-push-proof",
					definitive ? "fail" : "degraded",
					definitive
						? "saved push proof no longer exists at the authenticated remote ref"
						: "authenticated remote ref could not be verified",
					definitive ? "run rook push" : "retry rook doctor",
				),
			);
		}
	}

	return checks;
}

export async function doctor(options, dependencies = {}) {
	const identityPath = resolveIdentityPath(options, dependencies.env, dependencies.cwd);
	const paths = deriveIdentityPaths(identityPath);
	const checks = [];
	let identity;
	try {
		identity = await (dependencies.readIdentity ?? readIdentity)(identityPath);
		if (!identity) throw new RookError("identity file is missing");
		checks.push(check("identity-integrity", "ok", "identity file is valid"));
	} catch (error) {
		checks.push(
			check(
				"identity-integrity",
				"fail",
				error.message,
				"run rook enroll --invite <url> --handle <name>",
			),
		);
	}
	try {
		checks.push(await inspectPermissions(paths, dependencies));
	} catch {
		checks.push(
			check("secret-permissions", "degraded", "could not inspect secret file permissions"),
		);
	}
	if (identity) {
		try {
			const matches = await (dependencies.verifyHandleDid ?? verifyHandleDid)(
				identity,
				dependencies.fetch,
				dependencies,
			);
			checks.push(
				matches
					? check("handle-did-resolution", "ok", "stored handle and DID resolve bidirectionally")
					: check(
							"handle-did-resolution",
							"fail",
							"stored handle and DID do not resolve bidirectionally",
						),
			);
		} catch {
			checks.push(
				check("handle-did-resolution", "degraded", "could not verify handle and DID resolution"),
			);
		}
	} else {
		checks.push(
			check("handle-did-resolution", "not_checked", "identity prerequisite was not earned"),
		);
	}

	let metadata;
	if (identity) {
		try {
			metadata = await fetchClientMetadata(identity.serviceOrigin, dependencies);
		} catch {
			metadata = undefined;
		}
	}
	let session;
	let info;
	if (!identity) {
		checks.push(
			check("session-restore-expiry", "not_checked", "identity prerequisite was not earned"),
		);
	} else if (!(await fileExists(paths.sessionPath, dependencies.fs))) {
		checks.push(
			check("session-restore-expiry", "degraded", "no OAuth session is stored", "run rook login"),
		);
	} else if (!metadata) {
		checks.push(
			check(
				"session-restore-expiry",
				"degraded",
				"could not validate session because client metadata is unavailable",
				"run rook login",
			),
		);
	} else {
		try {
			const restored = await (dependencies.restoreSession ?? restoreSession)(
				identity,
				metadata,
				paths,
				dependencies,
			);
			try {
				await restored.transaction.promote();
			} catch (error) {
				await restored.transaction.rollback();
				throw error;
			}
			({ session, info } = restored);
			const fields = tokenInfoFields(info);
			checks.push(
				check(
					"session-restore-expiry",
					"ok",
					`OAuth session is restorable; expiresAt=${fields.expiresAt ?? "unspecified"}; expired=${fields.expired}`,
				),
			);
		} catch {
			checks.push(
				check(
					"session-restore-expiry",
					"fail",
					"OAuth session is invalid or unrefreshable",
					"run rook login",
				),
			);
		}
	}
	if (!metadata) {
		checks.push(
			check(
				"granted-scope",
				identity ? "degraded" : "not_checked",
				identity ? "client metadata is unavailable" : "identity prerequisite was not earned",
			),
		);
	} else if (!info) {
		checks.push(
			check("granted-scope", "not_checked", "restored session prerequisite was not earned"),
		);
	} else {
		const missing = missingScopes(metadata.scope, info.scope);
		checks.push(
			missing.length === 0
				? check("granted-scope", "ok", "granted scope includes every served scope token")
				: check("granted-scope", "fail", `missing scopes: ${missing.join(" ")}`, "run rook login"),
		);
	}

	let knot;
	if (!identity || !metadata) {
		checks.push(
			check("knot-membership", "not_checked", "served metadata prerequisite was not earned"),
		);
	} else {
		try {
			knot = deriveKnotTarget(metadata.scope);
			const members = await (dependencies.listKnotMembers ?? listKnotMembers)(knot, dependencies);
			checks.push(
				members.has(identity.did)
					? check(
							"knot-membership",
							"ok",
							"identity is present in exhaustive knot membership results",
						)
					: check(
							"knot-membership",
							"fail",
							"identity is absent from exhaustive knot membership results",
							`contact rook.host support to repair knot membership for ${identity.did}`,
						),
			);
		} catch {
			checks.push(check("knot-membership", "degraded", "could not verify membership"));
		}
	}
	const context = { identity, metadata, session, info, knot };
	for (const [name, nsid] of SERVICE_AUTH_CHECKS) {
		const auth = await serviceAuthCheck(name, nsid, context, dependencies);
		checks.push(auth.result);
		if (name === "service-auth-receive-pack") {
			context.receiveAuth = { status: auth.result.status, token: auth.token };
		}
	}
	checks.push(...(await repositoryChecks(context, dependencies)));
	return { ok: true, overall: overall(checks), checks };
}

export function register(program, dependencies = {}) {
	program
		.command("doctor")
		.description(
			"run read-only identity, authentication, and repository push-readiness diagnostics",
		)
		.option("--json", "emit structured JSON")
		.action(async (localOptions, command) => {
			const output = createOutput({ ...dependencies, json: localOptions.json });
			try {
				const result = await doctor(command.optsWithGlobals(), dependencies);
				const { ok: _ok, ...fields } = result;
				const human = [
					...result.checks.flatMap(({ name, status, detail, recovery }) => [
						`${name}: ${status} — ${detail}`,
						...(recovery ? [`  recovery: ${recovery}`] : []),
					]),
					result.overall.verdict,
				].join("\n");
				output.success(fields, human);
				process.exitCode = result.overall.status === "ok" ? 0 : 1;
			} catch (error) {
				output.failure(error);
				process.exitCode = 1;
			}
		});
}

export { overall as doctorOverall };
