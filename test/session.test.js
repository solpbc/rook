// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";
import { RookError } from "../src/lib/error-format.js";
import { restoreSession } from "../src/lib/session.js";

const identity = { did: "did:plc:rook" };
const metadata = { client_id: "https://rook.invalid/client-metadata.json" };
const paths = { sessionPath: "/tmp/session.json", statePath: "/tmp/state.json" };

function setup(infoOverrides = {}, sessionOverrides = {}) {
	let transaction;
	class Transaction {
		constructor(sessionPath, statePath, options) {
			this.sessionPath = sessionPath;
			this.statePath = statePath;
			this.options = options;
			this.stores = { sessionStore: {}, stateStore: {} };
			this.started = false;
			this.promoted = false;
			this.rolledBack = false;
			transaction = this;
		}

		async start() {
			this.started = true;
			return this;
		}

		async promote() {
			this.promoted = true;
		}

		async rollback() {
			this.rolledBack = true;
		}
	}
	const info = { sub: identity.did, scope: "atproto", expired: false, ...infoOverrides };
	const session = {
		did: identity.did,
		getTokenInfo: async (refresh) => {
			assert.equal(refresh, false);
			return info;
		},
		...sessionOverrides,
	};
	const dependencies = {
		LoginStorageTransaction: Transaction,
		clock: () => 123,
		fs: { fake: true },
		oauthClientFactory: (receivedMetadata, stores) => {
			assert.equal(receivedMetadata, metadata);
			assert.equal(stores, transaction.stores);
			return {
				restore: async (did) => {
					assert.equal(did, identity.did);
					return session;
				},
			};
		},
	};
	return { dependencies, info, session, transaction: () => transaction };
}

test("restoreSession returns a validated session and unpromoted transaction", async () => {
	const fake = setup();
	const result = await restoreSession(identity, metadata, paths, fake.dependencies);
	assert.equal(result.session, fake.session);
	assert.equal(result.info, fake.info);
	assert.equal(result.transaction, fake.transaction());
	assert.equal(result.transaction.started, true);
	assert.equal(result.transaction.promoted, false);
	assert.equal(result.transaction.rolledBack, false);
	assert.deepEqual(result.transaction.options, {
		clock: fake.dependencies.clock,
		fs: fake.dependencies.fs,
	});
});

for (const [name, infoOverrides, sessionOverrides] of [
	["session DID mismatch", {}, { did: "did:plc:other" }],
	["token subject mismatch", { sub: "did:plc:other" }, {}],
	["expired token", { expired: true }, {}],
]) {
	test(`restoreSession rolls back and rejects a ${name}`, async () => {
		const fake = setup(infoOverrides, sessionOverrides);
		await assert.rejects(
			restoreSession(identity, metadata, paths, fake.dependencies),
			(error) =>
				error instanceof RookError &&
				error.code === "session-invalid" &&
				error.remediation === "run rook login",
		);
		assert.equal(fake.transaction().rolledBack, true);
		assert.equal(fake.transaction().promoted, false);
	});
}
