// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { deriveIdentityPaths, resolveIdentityPath } from "../src/lib/paths.js";
import {
	AtomicMapStore,
	ExpiringStateStore,
	LoginStorageTransaction,
	atomicWriteFile,
} from "../src/lib/storage.js";
import { temporaryHome } from "./helpers.js";

test("identity path precedence and suffix derivation are deterministic", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	assert.equal(
		resolveIdentityPath({ identity: "chosen.json" }, home.env, home.directory),
		path.join(home.directory, "chosen.json"),
	);
	assert.equal(resolveIdentityPath({}, home.env, home.directory), home.env.ROOK_IDENTITY_FILE);
	const derived = deriveIdentityPaths(path.join(home.directory, "alice.json"));
	assert.equal(derived.sessionPath, path.join(home.directory, "alice.session.json"));
	assert.equal(derived.statePath, path.join(home.directory, "alice.state.json"));
});

test("atomic files and map stores are mode 0600", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	const filePath = path.join(home.directory, "secret.json");
	await atomicWriteFile(filePath, "{}\n");
	assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
	const store = new AtomicMapStore({ path: filePath });
	await store.set("did:plc:a", { value: 1 });
	assert.deepEqual(await store.get("did:plc:a"), { value: 1 });
	await store.del("did:plc:a");
	await assert.rejects(fs.stat(filePath), { code: "ENOENT" });
});

test("state store expires stale one-active state", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	const filePath = path.join(home.directory, "state.json");
	let now = Date.now();
	const store = new ExpiringStateStore({ path: filePath }, { clock: () => now, ttlMs: 100 });
	await store.set("first", { verifier: "one" });
	await store.set("second", { verifier: "two" });
	assert.equal(await store.get("first"), undefined);
	now += 1000;
	assert.equal(await store.get("second"), undefined);
});

test("failed login staging leaves canonical session bytes intact", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	const sessionPath = path.join(home.directory, "id.session.json");
	const statePath = path.join(home.directory, "id.state.json");
	const original = Buffer.from('{"did:plc:a":{"prior":true}}\n');
	await atomicWriteFile(sessionPath, original);
	const transaction = await new LoginStorageTransaction(sessionPath, statePath).start();
	await transaction.stores.sessionStore.del("did:plc:a");
	await transaction.rollback();
	assert.deepEqual(await fs.readFile(sessionPath), original);
});
