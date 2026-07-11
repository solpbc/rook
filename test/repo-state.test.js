// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { readRepoState, repoStatePath, writeRepoState } from "../src/lib/repo-state.js";
import { temporaryHome } from "./helpers.js";

const CORE_STATE = {
	upstreamUrl: "https://github.com/osaurus-ai/vmlx-swift.git",
	upstreamDefaultBranch: "main",
	knotRepoName: "vmlx-swift",
	knotRepoDid: "did:plc:y4n6knl55l5bcoazo6qki4iu",
	rookRemoteUrl: "https://knot.rook.host/did:plc:y4n6knl55l5bcoazo6qki4iu",
};

const PULL_STATE = {
	pullUri: "at://did:plc:testrook/sh.tangled.repo.pull/3mnezrl5u4722",
	pullRkey: "3mnezrl5u4722",
	pullCid: "bafyreib2rxk3rybk4dabcdefghijklmnopqrstuvwxyz234567",
	pullCreatedAt: "2026-07-11T00:00:00.000Z",
};

const RENDERED_STATE = {
	renderedPullUrl: "https://tangled.org/did:plc:testrook/vmlx-swift/pulls/5",
};

const CAP_STATE = {
	capUri: "at://did:plc:testrook/org.v-it.cap/3mnezrl5u4799",
	capRkey: "3mnezrl5u4799",
	capCid: "bafyreicapcidabcdefghijklmnopqrstuvwxyz234567abcd",
	capRef: "fast-lru-cache",
	capCreatedAt: "2026-07-11T00:00:00.000Z",
};

async function stateDirectory(t) {
	const home = await temporaryHome();
	t.after(home.cleanup);
	return path.join(home.directory, "repo", ".git");
}

async function writeRaw(gitCommonDir, value) {
	const filePath = repoStatePath(gitCommonDir);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, value, { mode: 0o600 });
}

test("repository state round-trips core fields and an atomic push-proof patch", async (t) => {
	const gitCommonDir = await stateDirectory(t);
	const created = await writeRepoState(gitCommonDir, CORE_STATE);
	assert.deepEqual(created, { ...CORE_STATE, version: 1 });
	const pushed = await writeRepoState(gitCommonDir, {
		lastPushedBranch: "extro/add-json-schema-constrained-decoding",
		lastPushedTip: "a".repeat(40),
	});
	assert.deepEqual(await readRepoState(gitCommonDir), pushed);
	assert.equal((await fs.stat(path.dirname(repoStatePath(gitCommonDir)))).mode & 0o777, 0o700);
	assert.equal((await fs.stat(repoStatePath(gitCommonDir))).mode & 0o777, 0o600);
});

test("missing repository state returns undefined", async (t) => {
	assert.equal(await readRepoState(await stateDirectory(t)), undefined);
});

test("malformed repository state fails loudly", async (t) => {
	const gitCommonDir = await stateDirectory(t);
	await writeRaw(gitCommonDir, "not-json");
	await assert.rejects(readRepoState(gitCommonDir), (error) => error.code === "state-invalid");
});

test("unknown fields and versions are rejected", async (t) => {
	const unknownKeyDir = await stateDirectory(t);
	await writeRaw(unknownKeyDir, JSON.stringify({ ...CORE_STATE, version: 1, unexpected: "value" }));
	await assert.rejects(readRepoState(unknownKeyDir), (error) => error.code === "state-invalid");

	const unknownVersionDir = await stateDirectory(t);
	await writeRaw(unknownVersionDir, JSON.stringify({ ...CORE_STATE, version: 2 }));
	await assert.rejects(readRepoState(unknownVersionDir), (error) => error.code === "state-invalid");
});

test("invalid DID and rook remote combinations are rejected", async (t) => {
	const badDidDir = await stateDirectory(t);
	await assert.rejects(
		writeRepoState(badDidDir, { ...CORE_STATE, knotRepoDid: "not-a-did" }),
		(error) => error.code === "state-invalid",
	);

	const badRemoteDir = await stateDirectory(t);
	await assert.rejects(
		writeRepoState(badRemoteDir, {
			...CORE_STATE,
			rookRemoteUrl: "https://knot.rook.host/did:plc:different",
		}),
		(error) => error.code === "state-invalid",
	);
});

test("half-present or malformed push proof is rejected", async (t) => {
	const halfDir = await stateDirectory(t);
	await assert.rejects(
		writeRepoState(halfDir, { ...CORE_STATE, lastPushedBranch: "main" }),
		(error) => error.code === "state-invalid",
	);

	const badTipDir = await stateDirectory(t);
	await assert.rejects(
		writeRepoState(badTipDir, {
			...CORE_STATE,
			lastPushedBranch: "main",
			lastPushedTip: "short",
		}),
		(error) => error.code === "state-invalid",
	);
});

test("state schema rejects secret-bearing patch keys", async (t) => {
	const gitCommonDir = await stateDirectory(t);
	await assert.rejects(
		writeRepoState(gitCommonDir, { ...CORE_STATE, token: "must-not-persist" }),
		(error) => error.code === "state-invalid",
	);
	assert.equal(await readRepoState(gitCommonDir), undefined);
});

test("pull, rendered, and cap groups round-trip as an additive layer", async (t) => {
	const gitCommonDir = await stateDirectory(t);
	await writeRepoState(gitCommonDir, CORE_STATE);
	const withPull = await writeRepoState(gitCommonDir, PULL_STATE);
	assert.deepEqual(withPull, { ...CORE_STATE, ...PULL_STATE, version: 1 });
	const withRendered = await writeRepoState(gitCommonDir, RENDERED_STATE);
	const full = await writeRepoState(gitCommonDir, CAP_STATE);
	assert.deepEqual(full, {
		...CORE_STATE,
		...PULL_STATE,
		...RENDERED_STATE,
		...CAP_STATE,
		version: 1,
	});
	assert.deepEqual(await readRepoState(gitCommonDir), full);
	// capRef is stored verbatim, never redacted at the storage boundary.
	assert.equal(full.capRef, "fast-lru-cache");
	void withRendered;
});

test("partial pull group is rejected", async (t) => {
	const gitCommonDir = await stateDirectory(t);
	await writeRepoState(gitCommonDir, CORE_STATE);
	await assert.rejects(
		writeRepoState(gitCommonDir, { pullUri: PULL_STATE.pullUri, pullRkey: PULL_STATE.pullRkey }),
		(error) => error.code === "state-invalid",
	);
});

test("rendered pull URL requires the pull group", async (t) => {
	const gitCommonDir = await stateDirectory(t);
	await writeRepoState(gitCommonDir, CORE_STATE);
	await assert.rejects(
		writeRepoState(gitCommonDir, RENDERED_STATE),
		(error) => error.code === "state-invalid",
	);
});

test("cap group requires a resolved pull", async (t) => {
	const gitCommonDir = await stateDirectory(t);
	await writeRepoState(gitCommonDir, { ...CORE_STATE, ...PULL_STATE });
	// pull present but rendered URL absent -> cap rejected.
	await assert.rejects(
		writeRepoState(gitCommonDir, CAP_STATE),
		(error) => error.code === "state-invalid",
	);
});

test("malformed pull, rendered, and cap fields are rejected", async (t) => {
	const base = { ...CORE_STATE, ...PULL_STATE, ...RENDERED_STATE };

	const badUriDir = await stateDirectory(t);
	await assert.rejects(
		writeRepoState(badUriDir, {
			...CORE_STATE,
			...PULL_STATE,
			pullUri: "at://did:plc:testrook/org.v-it.cap/3mnezrl5u4722",
		}),
		(error) => error.code === "state-invalid",
	);

	const roundSuffixDir = await stateDirectory(t);
	await assert.rejects(
		writeRepoState(roundSuffixDir, {
			...CORE_STATE,
			...PULL_STATE,
			renderedPullUrl: "https://tangled.org/did:plc:testrook/vmlx-swift/pulls/5/round/1",
		}),
		(error) => error.code === "state-invalid",
	);

	const queryDir = await stateDirectory(t);
	await assert.rejects(
		writeRepoState(queryDir, {
			...CORE_STATE,
			...PULL_STATE,
			renderedPullUrl: "https://tangled.org/did:plc:testrook/vmlx-swift/pulls/5?tab=diff",
		}),
		(error) => error.code === "state-invalid",
	);

	const badRefDir = await stateDirectory(t);
	await assert.rejects(
		writeRepoState(badRefDir, { ...base, ...CAP_STATE, capRef: "not-three" }),
		(error) => error.code === "state-invalid",
	);

	const badCidDir = await stateDirectory(t);
	await assert.rejects(
		writeRepoState(badCidDir, { ...base, ...CAP_STATE, capCid: "has/slash" }),
		(error) => error.code === "state-invalid",
	);
});
