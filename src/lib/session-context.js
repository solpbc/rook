// SPDX-License-Identifier: AGPL-3.0-only

import { Agent } from "@atproto/api";
import { RookError } from "./error-format.js";
import { deriveKnotTarget } from "./knot.js";
import { fetchClientMetadata, missingScopes } from "./oauth.js";
import { deriveIdentityPaths } from "./paths.js";
import { restoreSession } from "./session.js";
import { fileExists } from "./storage.js";

function failure(error, { stage, code, remediation, message }) {
	if (error instanceof RookError) {
		return new RookError(message ?? error.message, {
			cause: error.cause,
			hint: error.hint,
			stage: error.stage ?? stage,
			code: error.code ?? code,
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

// Restore one OAuth session and build the single agent that pr/ship/submit thread
// through their record writes. The transaction is NOT promoted here: the scope
// and knot checks must fail closed before any command promotes refreshed tokens,
// and submit promotes exactly once across its four stages. On a scope or knot
// failure the transaction is rolled back so no refreshed tokens are committed.
export async function restoreContext(identity, identityPath, dependencies = {}) {
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
	} catch (error) {
		await restored.transaction.rollback().catch(() => {});
		throw error;
	}
	const createAgent = dependencies.createAgent ?? ((session) => new Agent(session));
	const agent = createAgent(restored.session);
	return {
		identity,
		metadata,
		info: restored.info,
		knot,
		session: restored.session,
		agent,
		transaction: restored.transaction,
	};
}

// Fail closed if a submitted shared context does not belong to the resolved
// identity. Provenance depends on the agent DID equalling the logged-in rook.
export function assertContextIdentity(context, identity) {
	if (
		context.session?.did !== identity.did ||
		context.info?.sub !== identity.did ||
		context.agent?.did !== identity.did
	) {
		throw new RookError("restored session does not match the selected identity", {
			stage: "session",
			code: "session-identity-mismatch",
			remediation: "run rook login",
		});
	}
}
