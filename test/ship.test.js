// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";
import { ship, shipCore } from "../src/cmd/ship.js";
import { resolveGitCommonDir } from "../src/lib/git.js";
import { readRepoState, writeRepoState } from "../src/lib/repo-state.js";
import { temporaryGitRepository } from "./helpers.js";

const ROOK_DID = "did:plc:testrook";
const KNOT_DID = "did:plc:knotrepo00000000000000";
const KNOT_HOST = "knot.rook.host";
const ROOK_REMOTE = `https://${KNOT_HOST}/${KNOT_DID}`;
const REPO_NAME = "widget";
const UPSTREAM = "https://github.com/owner/widget.git";
const CAP = "org.v-it.cap";
const PULL_URI = `at://${ROOK_DID}/sh.tangled.repo.pull/pull1`;
const RENDERED = `https://tangled.org/${ROOK_DID}/${REPO_NAME}/pulls/7`;
const BEACON = "vit:github.com/owner/widget";
const TITLE = "feature → main";
const DESCRIPTION = "rook pull for github.com/owner/widget";

const PULL_STATE = {
	pullUri: PULL_URI,
	pullRkey: "pull1",
	pullCid: "bafpullcid0",
	pullCreatedAt: "2026-07-05T00:00:00.000Z",
	renderedPullUrl: RENDERED,
};

function capAgent({ caps, puts }) {
	let counter = caps.size;
	return {
		did: ROOK_DID,
		com: {
			atproto: {
				repo: {
					getRecord: async ({ repo, collection, rkey }) => {
						const entry = caps.get(rkey);
						if (!entry) {
							throw Object.assign(new Error("RecordNotFound"), {
								status: 400,
								error: "RecordNotFound",
							});
						}
						return {
							data: {
								uri: `at://${repo}/${collection}/${rkey}`,
								cid: entry.cid,
								value: entry.value,
							},
						};
					},
					listRecords: async ({ repo, collection }) => {
						const records = [...caps.entries()].map(([rkey, entry]) => ({
							uri: `at://${repo}/${collection}/${rkey}`,
							cid: entry.cid,
							value: entry.value,
						}));
						return { data: { records, cursor: undefined } };
					},
					putRecord: async ({ repo, collection, rkey, record, swapRecord }) => {
						const existing = caps.get(rkey);
						if (swapRecord !== undefined && (!existing || existing.cid !== swapRecord)) {
							throw Object.assign(new Error("InvalidSwap"), { status: 400, error: "InvalidSwap" });
						}
						counter += 1;
						const cid = `bafcapcid${counter}0`;
						caps.set(rkey, { cid, value: record });
						puts.push({ repo, rkey, record, swapRecord });
						return { data: { uri: `at://${repo}/${collection}/${rkey}`, cid } };
					},
				},
			},
		},
	};
}

async function setupShip(t, { caps = new Map(), statePatch = {}, includeRendered = true } = {}) {
	const repo = await temporaryGitRepository();
	t.after(repo.cleanup);
	await repo.commit({ message: "base" });
	const gitCommonDir = await resolveGitCommonDir(repo.directory, {});
	const pullState = includeRendered ? PULL_STATE : { ...PULL_STATE, renderedPullUrl: undefined };
	const cleanPullState = Object.fromEntries(
		Object.entries(pullState).filter(([, value]) => value !== undefined),
	);
	await writeRepoState(gitCommonDir, {
		upstreamUrl: UPSTREAM,
		upstreamDefaultBranch: "main",
		knotRepoName: REPO_NAME,
		knotRepoDid: KNOT_DID,
		rookRemoteUrl: ROOK_REMOTE,
		lastPushedBranch: "feature",
		lastPushedTip: "a".repeat(40),
		...cleanPullState,
		...statePatch,
	});

	const puts = [];
	const agent = capAgent({ caps, puts });
	const calls = { promotes: 0, rollbacks: 0 };
	const dependencies = {
		cwd: repo.directory,
		env: { ...repo.env },
		clock: () => 1_700_000_000_000,
		readIdentity: async () => ({
			did: ROOK_DID,
			handle: "rook.invalid",
			serviceOrigin: "https://rook.invalid",
		}),
		restoreContext: async () => ({
			identity: { did: ROOK_DID },
			knot: { host: KNOT_HOST },
			session: { did: ROOK_DID },
			info: { sub: ROOK_DID },
			agent,
			transaction: {
				promote: async () => {
					calls.promotes += 1;
				},
				rollback: async () => {
					calls.rollbacks += 1;
				},
			},
		}),
	};
	return { repo, gitCommonDir, agent, puts, caps, calls, dependencies };
}

function unchangedCapValue(overrides = {}) {
	return {
		$type: CAP,
		text: "",
		title: TITLE,
		description: DESCRIPTION,
		ref: "rook-aaaaaa-bbbbbb",
		beacon: BEACON,
		kind: "feat",
		embed: { external: { uri: RENDERED, title: TITLE, description: DESCRIPTION } },
		createdAt: "2026-07-01T00:00:00.000Z",
		...overrides,
	};
}

async function readState(gitCommonDir) {
	return readRepoState(gitCommonDir, {});
}

test("ship creates a cap embedding the pull URL and beacon, targeting the rook DID", async (t) => {
	const setup = await setupShip(t);
	const result = await ship({ json: true }, setup.dependencies);
	assert.equal(result.outcome, "created");
	assert.match(result.capRef, /^[a-z]+-[a-z]+-[a-z]+$/);
	assert.equal(result.renderedPullUrl, RENDERED);

	const written = setup.puts[0];
	assert.equal(written.repo, ROOK_DID);
	assert.deepEqual(written.record.embed.external, {
		uri: RENDERED,
		title: TITLE,
		description: DESCRIPTION,
	});
	assert.equal(written.record.beacon, BEACON);
	assert.equal(written.record.kind, "feat");

	const state = await readState(setup.gitCommonDir);
	assert.equal(state.capRef, result.capRef);
	assert.equal(state.capUri, result.capUri);
	// capRef is surfaced verbatim, never redacted.
	assert.notEqual(state.capRef, "[REDACTED]");
});

test("ship adopts an unchanged cap on rerun without writing", async (t) => {
	const caps = new Map([
		[
			"noise",
			{
				cid: "bafnoise00",
				value: {
					$type: CAP,
					beacon: "vit:other//x",
					embed: { external: { uri: "https://x/y/pulls/1" } },
				},
			},
		],
		["cap1", { cid: "bafcap0000", value: unchangedCapValue() }],
	]);
	const setup = await setupShip(t, {
		caps,
		statePatch: {
			capUri: `at://${ROOK_DID}/${CAP}/cap1`,
			capRkey: "cap1",
			capCid: "bafcap0000",
			capRef: "rook-aaaaaa-bbbbbb",
			capCreatedAt: "2026-07-01T00:00:00.000Z",
		},
	});
	const result = await ship({ json: true }, setup.dependencies);
	assert.equal(result.outcome, "adopted");
	assert.equal(result.capRef, "rook-aaaaaa-bbbbbb");
	assert.equal(setup.puts.length, 0);
});

test("ship refreshes with CAS and preserves the ref when content changes", async (t) => {
	const caps = new Map([["cap1", { cid: "bafcap0000", value: unchangedCapValue() }]]);
	const setup = await setupShip(t, {
		caps,
		statePatch: {
			capUri: `at://${ROOK_DID}/${CAP}/cap1`,
			capRkey: "cap1",
			capCid: "bafcap0000",
			capRef: "rook-aaaaaa-bbbbbb",
			capCreatedAt: "2026-07-01T00:00:00.000Z",
		},
	});
	const result = await ship({ json: true, title: "new title" }, setup.dependencies);
	assert.equal(result.outcome, "refreshed");
	assert.equal(result.capRef, "rook-aaaaaa-bbbbbb");
	const written = setup.puts[0];
	assert.equal(written.swapRecord, "bafcap0000");
	assert.equal(written.record.title, "new title");
	assert.equal(written.record.ref, "rook-aaaaaa-bbbbbb");
	assert.equal(written.record.createdAt, "2026-07-01T00:00:00.000Z");
});

test("ship --request sets strong reply references and creates a reply cap", async (t) => {
	const requester = "did:plc:requester0000000000000";
	const requestUri = `at://${requester}/${CAP}/req`;
	const rootRef = { uri: `at://${requester}/${CAP}/root`, cid: "bafroot00" };
	const caps = new Map([
		["req", { cid: "bafreq000", value: { $type: CAP, reply: { root: rootRef } } }],
	]);
	const setup = await setupShip(t, { caps });
	const result = await ship({ json: true, request: requestUri }, setup.dependencies);
	assert.equal(result.outcome, "created");
	const written = setup.puts.find((put) => put.rkey !== "req");
	assert.equal(written.record.reply.parent.uri, requestUri);
	assert.equal(written.record.reply.parent.cid, "bafreq000");
	assert.deepEqual(written.record.reply.root, rootRef);
});

test("ship --request fails before any write when the request cap is missing", async (t) => {
	const setup = await setupShip(t);
	await assert.rejects(
		ship(
			{ json: true, request: `at://did:plc:requester0000000000000/${CAP}/missing` },
			setup.dependencies,
		),
		(error) => error.code === "request-cap-unresolved",
	);
	assert.equal(setup.puts.length, 0);
});

test("ship without --request never reparents an existing request reply cap", async (t) => {
	const replyCap = unchangedCapValue({
		reply: {
			root: { uri: "at://r/root", cid: "bafroot" },
			parent: { uri: "at://r/req", cid: "bafreq" },
		},
	});
	const caps = new Map([["reply1", { cid: "bafreply00", value: replyCap }]]);
	const setup = await setupShip(t, { caps });
	const result = await ship({ json: true }, setup.dependencies);
	// A fresh plain cap is created; the reply cap is left untouched.
	assert.equal(result.outcome, "created");
	assert.ok(
		setup.puts.every((put) => put.rkey !== "reply1"),
		"reply cap not rewritten",
	);
	assert.deepEqual(setup.caps.get("reply1").value, replyCap);
});

test("ship fails without a write when multiple caps match", async (t) => {
	const value = unchangedCapValue();
	const caps = new Map([
		["one", { cid: "bafone000", value }],
		["two", { cid: "baftwo000", value }],
	]);
	const setup = await setupShip(t, { caps });
	await assert.rejects(
		ship({ json: true }, setup.dependencies),
		(error) => error.code === "cap-ambiguous",
	);
	assert.equal(setup.puts.length, 0);
});

test("ship requires a verified rendered pull URL", async (t) => {
	const setup = await setupShip(t, { includeRendered: false });
	await assert.rejects(
		ship({ json: true }, setup.dependencies),
		(error) => error.code === "rendered-url-missing",
	);
});

test("shipCore with a provided context skips its own restore and promotion", async (t) => {
	const setup = await setupShip(t);
	const context = await setup.dependencies.restoreContext();
	const before = setup.calls.promotes;
	const result = await shipCore({ json: true }, context, setup.dependencies);
	assert.equal(result.outcome, "created");
	assert.equal(setup.calls.promotes, before, "submit owns promotion, not the core");
});

test("ship recovers after a durable write then a state failure without duplicating", async (t) => {
	const setup = await setupShip(t);
	let calls = 0;
	setup.dependencies.writeRepoState = async (dir, patch, deps) => {
		calls += 1;
		if (calls === 1) throw Object.assign(new Error("disk full"), { code: "state-write-failed" });
		return writeRepoState(dir, patch, deps);
	};
	await assert.rejects(
		ship({ json: true }, setup.dependencies),
		(error) => error.code === "state-write-failed",
	);
	assert.equal(setup.caps.size, 1, "the cap was durably created");

	setup.dependencies.writeRepoState = undefined;
	const result = await ship({ json: true }, setup.dependencies);
	assert.equal(result.outcome, "adopted");
	assert.equal(setup.caps.size, 1);
});
