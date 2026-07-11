// SPDX-License-Identifier: AGPL-3.0-only

import { RookError } from "./error-format.js";
import { createOAuthClient } from "./oauth.js";
import { LoginStorageTransaction } from "./storage.js";

function invalidSession() {
	return new RookError("stored OAuth session is invalid or unrefreshable", {
		code: "session-invalid",
		remediation: "run rook login",
	});
}

export async function restoreSession(identity, metadata, paths, dependencies = {}) {
	const Transaction = dependencies.LoginStorageTransaction ?? LoginStorageTransaction;
	const transaction = new Transaction(paths.sessionPath, paths.statePath, {
		clock: dependencies.clock,
		fs: dependencies.fs,
	});
	try {
		await transaction.start();
		const client = dependencies.oauthClientFactory
			? dependencies.oauthClientFactory(metadata, transaction.stores)
			: createOAuthClient(metadata, transaction.stores, dependencies);
		const session = await client.restore(identity.did);
		const info = await session.getTokenInfo(false);
		if (session.did !== identity.did || info.sub !== identity.did || info.expired === true) {
			throw invalidSession();
		}
		return { session, info, transaction };
	} catch {
		try {
			await transaction.rollback();
		} catch {
			// The caller still receives one sanitized, fail-closed session error.
		}
		throw invalidSession();
	}
}
