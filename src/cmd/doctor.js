// SPDX-License-Identifier: AGPL-3.0-only

import { verifyHandleDid } from "../lib/discovery.js";
import { RookError } from "../lib/error-format.js";
import { readIdentity } from "../lib/identity.js";
import { createOutput } from "../lib/json-output.js";
import { deriveKnotTarget, listKnotMembers } from "../lib/knot.js";
import { timeoutSignal } from "../lib/network.js";
import {
	createOAuthClient,
	fetchClientMetadata,
	missingScopes,
	rpcScopes,
	tokenInfoFields,
} from "../lib/oauth.js";
import { deriveIdentityPaths, resolveIdentityPath } from "../lib/paths.js";
import { LoginStorageTransaction, fileExists, fileMode } from "../lib/storage.js";

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
			verdict: "identity/auth diagnostics failed; repository push has not been checked yet",
		};
	}
	if (checks.some(({ status }) => status === "degraded")) {
		return {
			status: "degraded",
			verdict: "identity/auth diagnostics degraded; repository push has not been checked yet",
		};
	}
	if (checks.some(({ name, status }) => name !== "repository-push" && status === "not_checked")) {
		return {
			status: "not_checked",
			verdict: "identity/auth diagnostics incomplete; repository push has not been checked yet",
		};
	}
	return {
		status: "not_checked",
		verdict: "identity/auth checks passed; repository push has not been checked yet",
	};
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

async function restoreSession(identity, metadata, paths, dependencies) {
	const Transaction = dependencies.LoginStorageTransaction ?? LoginStorageTransaction;
	const transaction = await new Transaction(paths.sessionPath, paths.statePath, {
		clock: dependencies.clock,
		fs: dependencies.fs,
	}).start();
	try {
		const client = dependencies.oauthClientFactory
			? dependencies.oauthClientFactory(metadata, transaction.stores)
			: createOAuthClient(metadata, transaction.stores, dependencies);
		const session = await client.restore(identity.did);
		const info = await session.getTokenInfo(false);
		if (session.did !== identity.did || info.sub !== identity.did || info.expired === true) {
			throw new RookError("stored session is invalid or expired");
		}
		await transaction.promote();
		return { session, info };
	} catch (error) {
		await transaction.rollback();
		throw error;
	}
}

async function serviceAuthCheck(name, nsid, context, dependencies) {
	if (!context.session || !context.knot)
		return check(name, "not_checked", "prerequisites were not earned");
	const expected = rpcScopes(context.metadata.scope).find(
		(entry) => entry.nsid === nsid && entry.aud === context.knot.aud,
	)?.token;
	if (!expected)
		return check(
			name,
			"fail",
			`served client metadata is missing the ${nsid} RPC scope`,
			"run rook login",
		);
	const now = Math.floor((dependencies.clock?.() ?? Date.now()) / 1000);
	const url = new URL("/xrpc/com.atproto.server.getServiceAuth", context.identity.serviceOrigin);
	url.searchParams.set("aud", context.knot.aud);
	url.searchParams.set("lxm", nsid);
	url.searchParams.set("exp", String(now + 60));
	let response;
	try {
		response = await context.session.fetchHandler(url.toString(), {
			signal: timeoutSignal(dependencies),
		});
	} catch {
		return check(name, "degraded", "could not mint service authorization");
	}
	let body;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	if (response.status === 200 && typeof body?.token === "string") {
		return check(name, "ok", `service authorization for ${nsid} can be minted read-only`);
	}
	if (response.status === 403 && body?.error === "InsufficientScope") {
		return check(name, "fail", `missing required scope ${expected}`, "run rook login");
	}
	if (response.status === 401)
		return check(name, "fail", "OAuth session was rejected", "run rook login");
	return check(name, "degraded", "could not mint service authorization");
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
			({ session, info } = await restoreSession(identity, metadata, paths, dependencies));
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
		checks.push(await serviceAuthCheck(name, nsid, context, dependencies));
	}
	checks.push(check("repository-push", "not_checked", "repository push has not been checked yet"));
	return { ok: true, overall: overall(checks), checks };
}

export function register(program, dependencies = {}) {
	program
		.command("doctor")
		.description("run read-only identity and authentication diagnostics")
		.option("--json", "emit structured JSON")
		.action(async (localOptions, command) => {
			const output = createOutput({ ...dependencies, json: localOptions.json });
			try {
				const result = await doctor(command.optsWithGlobals(), dependencies);
				const { ok: _ok, ...fields } = result;
				const human = [
					...result.checks.flatMap(({ name, status, detail, recovery }) => [
						`${name}: ${status} — ${detail}`,
						...(recovery && (status === "fail" || status === "degraded")
							? [`  recovery: ${recovery}`]
							: []),
					]),
					result.overall.verdict,
				].join("\n");
				output.success(fields, human);
				const incomplete = result.checks.some(
					({ name, status }) => name !== "repository-push" && status !== "ok",
				);
				process.exitCode = incomplete ? 1 : 0;
			} catch (error) {
				output.failure(error);
				process.exitCode = 1;
			}
		});
}

export { overall as doctorOverall };
