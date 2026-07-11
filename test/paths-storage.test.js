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
	atomicCreateFile,
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

test("default identity path honors injected XDG config without an identity override", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	const env = { HOME: home.directory, XDG_CONFIG_HOME: path.join(home.directory, "xdg") };
	assert.equal(
		resolveIdentityPath({}, env, home.directory),
		path.join(env.XDG_CONFIG_HOME, "rook", "identity.json"),
	);
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

test("atomic replacement failure leaves no target or temporary file", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	const filePath = path.join(home.directory, "failed.json");
	const fsOps = {
		...fs,
		rename: async () => {
			throw new Error("rename failed");
		},
	};
	await assert.rejects(atomicWriteFile(filePath, "secret", fsOps), /rename failed/);
	assert.deepEqual(await fs.readdir(home.directory), []);
});

test("atomic create does not replace an existing file", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	const filePath = path.join(home.directory, "identity.json");
	await fs.writeFile(filePath, "original", { mode: 0o600 });
	await assert.rejects(atomicCreateFile(filePath, "replacement"), { code: "EEXIST" });
	assert.equal(await fs.readFile(filePath, "utf8"), "original");
});

test("malformed map JSON hard-fails", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	const filePath = path.join(home.directory, "malformed.json");
	await fs.writeFile(filePath, "not-json", { mode: 0o600 });
	const store = new AtomicMapStore({ path: filePath });
	await assert.rejects(store.get("did:plc:test"), SyntaxError);
});

test("failed transaction start removes every staging file", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	const sessionPath = path.join(home.directory, "id.session.json");
	const statePath = path.join(home.directory, "id.state.json");
	const fsOps = {
		...fs,
		rename: async (source, destination) => {
			if (destination.includes(".state.json.stage.")) throw new Error("state staging failed");
			return fs.rename(source, destination);
		},
	};
	const transaction = new LoginStorageTransaction(sessionPath, statePath, { fs: fsOps });
	await assert.rejects(transaction.start(), /state staging failed/);
	assert.deepEqual(await fs.readdir(home.directory), []);
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
