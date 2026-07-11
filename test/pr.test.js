// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";
import { pr, prCore } from "../src/cmd/pr.js";
import { resolveGitCommonDir } from "../src/lib/git.js";
import { readRepoState, writeRepoState } from "../src/lib/repo-state.js";
import { temporaryGitRepository } from "./helpers.js";

const ROOK_DID = "did:plc:testrook";
const KNOT_DID = "did:plc:knotrepo00000000000000";
const KNOT_HOST = "knot.rook.host";
const ROOK_REMOTE = `https://${KNOT_HOST}/${KNOT_DID}`;
const REPO_NAME = "widget";
const UPSTREAM = "https://github.com/owner/widget.git";
const APPVIEW = "https://tangled.org";
const PULL_COLLECTION = "sh.tangled.repo.pull";

function pullAgent({ pulls, uploads, puts }) {
	let counter = pulls.size;
	return {
		did: ROOK_DID,
		com: {
			atproto: {
				repo: {
					uploadBlob: async (bytes, opts) => {
						uploads.push({ encoding: opts?.encoding, length: bytes.length });
						counter += 1;
						return {
							data: {
								blob: {
									$type: "blob",
									ref: { $link: `bafblob${counter}` },
									mimeType: opts?.encoding,
									size: bytes.length,
								},
							},
						};
					},
					getRecord: async ({ repo, collection, rkey }) => {
						const entry = pulls.get(rkey);
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
						const records = [...pulls.entries()].map(([rkey, entry]) => ({
							uri: `at://${repo}/${collection}/${rkey}`,
							cid: entry.cid,
							value: entry.value,
						}));
						return { data: { records, cursor: undefined } };
					},
					putRecord: async ({ repo, collection, rkey, record, swapRecord }) => {
						const existing = pulls.get(rkey);
						if (swapRecord !== undefined && (!existing || existing.cid !== swapRecord)) {
							throw Object.assign(new Error("InvalidSwap"), { status: 400, error: "InvalidSwap" });
						}
						counter += 1;
						const cid = `bafpull${counter}0`;
						pulls.set(rkey, { cid, value: record });
						puts.push({ rkey, record, swapRecord });
						return { data: { uri: `at://${repo}/${collection}/${rkey}`, cid } };
					},
				},
			},
		},
	};
}

function renderFetch({ owner, repoSlug, id, converge = true, pullUri }) {
	const base = `${APPVIEW}/${owner}/${repoSlug}/pulls`;
	const pages = {
		[base]: `<a href="/${owner}/${repoSlug}/pulls/${id}">pull</a>`,
		[`${base}/${id}`]: converge
			? `<article data-aturi="${pullUri}"></article>`
			: `<article data-aturi="at://did:plc:other/${PULL_COLLECTION}/zzz"></article>`,
	};
	return async (url) => {
		const body = pages[String(url)];
		if (body === undefined) return { ok: false, status: 404, text: async () => "" };
		return { ok: true, status: 200, text: async () => body };
	};
}

async function setupPr(
	t,
	{ statePatch = {}, pulls = new Map(), rkey = "pull1", converge = true, pullId = 7 } = {},
) {
	const repo = await temporaryGitRepository();
	t.after(repo.cleanup);
	const base = await repo.commit({ message: "base" });
	await repo.run(["update-ref", "refs/remotes/origin/main", "HEAD"]);
	await repo.run(["checkout", "-q", "-b", "feature"]);
	const tip = await repo.commit({ message: "feature work" });
	const gitCommonDir = await resolveGitCommonDir(repo.directory, {});
	await writeRepoState(gitCommonDir, {
		upstreamUrl: UPSTREAM,
		upstreamDefaultBranch: "main",
		knotRepoName: REPO_NAME,
		knotRepoDid: KNOT_DID,
		rookRemoteUrl: ROOK_REMOTE,
		lastPushedBranch: "feature",
		lastPushedTip: tip,
		...statePatch,
	});

	const uploads = [];
	const puts = [];
	const agent = pullAgent({ pulls, uploads, puts });
	const calls = { promotes: 0, rollbacks: 0 };
	const pullUri = `at://${ROOK_DID}/${PULL_COLLECTION}/${rkey}`;
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
		newRkey: () => rkey,
		appviewOrigin: APPVIEW,
		fetch: renderFetch({ owner: ROOK_DID, repoSlug: REPO_NAME, id: pullId, converge, pullUri }),
		clockNow: undefined,
		sleep: async () => {},
		renderedUrlMaxRounds: 2,
	};
	return {
		repo,
		gitCommonDir,
		agent,
		uploads,
		puts,
		pulls,
		calls,
		dependencies,
		base,
		tip,
		pullUri,
	};
}

async function readState(gitCommonDir) {
	return readRepoState(gitCommonDir, {});
}

test("pr creates a self-pull with a patch round and resolves the rendered URL", async (t) => {
	const setup = await setupPr(t);
	const result = await pr({ json: true }, setup.dependencies);
	assert.equal(result.outcome, "created");
	assert.equal(result.renderedPullUrl, `${APPVIEW}/${ROOK_DID}/${REPO_NAME}/pulls/7`);

	const written = setup.puts[0];
	assert.equal(written.record.$type, PULL_COLLECTION);
	assert.deepEqual(written.record.source, { branch: "feature" });
	assert.equal(written.record.target.repo, KNOT_DID);
	assert.equal(written.record.target.repoDid, KNOT_DID);
	assert.equal(written.record.target.branch, "main");
	assert.equal(written.record.rounds.length, 1);
	assert.equal(setup.uploads[0].encoding, "application/gzip");

	const state = await readState(setup.gitCommonDir);
	assert.equal(state.pullRkey, "pull1");
	assert.equal(state.pullUri, setup.pullUri);
	assert.equal(state.renderedPullUrl, result.renderedPullUrl);
});

test("pr targets the rook DID for the pull record", async (t) => {
	const setup = await setupPr(t);
	await pr({ json: true }, setup.dependencies);
	assert.ok(setup.pulls.has("pull1"));
	assert.equal(setup.pullUri.startsWith(`at://${ROOK_DID}/`), true);
});

test("plain pr adopts an existing self-pull without appending a round", async (t) => {
	const existing = {
		cid: "bafexisting0",
		value: {
			$type: PULL_COLLECTION,
			title: "feature → main",
			source: { branch: "feature" },
			target: { repo: KNOT_DID, branch: "main", repoDid: KNOT_DID },
			createdAt: "2026-07-01T00:00:00.000Z",
			rounds: [{ createdAt: "2026-07-01T00:00:00.000Z", patchBlob: { $type: "blob" } }],
		},
	};
	const pulls = new Map([["pull1", existing]]);
	const setup = await setupPr(t, { pulls, statePatch: {} });
	const result = await pr({ json: true }, setup.dependencies);
	assert.equal(result.outcome, "adopted");
	assert.equal(setup.puts.length, 0);
	assert.equal(setup.uploads.length, 0);
	assert.equal(setup.pulls.get("pull1").value.rounds.length, 1);
});

test("pr rediscovers an existing pull across all records with no local state", async (t) => {
	const existing = {
		cid: "bafexisting0",
		value: {
			$type: PULL_COLLECTION,
			title: "feature → main",
			source: { branch: "feature" },
			target: { repo: KNOT_DID, branch: "main", repoDid: KNOT_DID },
			createdAt: "2026-07-01T00:00:00.000Z",
			rounds: [{ createdAt: "2026-07-01T00:00:00.000Z", patchBlob: { $type: "blob" } }],
		},
	};
	const pulls = new Map([["discovered", existing]]);
	const setup = await setupPr(t, { pulls, pullId: 3 });
	// The rendered fetch must key off the discovered rkey.
	setup.dependencies.fetch = renderFetch({
		owner: ROOK_DID,
		repoSlug: REPO_NAME,
		id: 3,
		pullUri: `at://${ROOK_DID}/${PULL_COLLECTION}/discovered`,
	});
	const result = await pr({ json: true }, setup.dependencies);
	assert.equal(result.outcome, "adopted");
	assert.equal(result.pullRkey, "discovered");
	assert.equal(setup.puts.length, 0);
});

test("pr fails without a write when multiple pulls match", async (t) => {
	const value = {
		$type: PULL_COLLECTION,
		title: "feature → main",
		source: { branch: "feature" },
		target: { repo: KNOT_DID, branch: "main", repoDid: KNOT_DID },
		createdAt: "2026-07-01T00:00:00.000Z",
		rounds: [{ createdAt: "2026-07-01T00:00:00.000Z", patchBlob: { $type: "blob" } }],
	};
	const pulls = new Map([
		["one", { cid: "bafone000", value }],
		["two", { cid: "baftwo000", value }],
	]);
	const setup = await setupPr(t, { pulls });
	await assert.rejects(
		pr({ json: true }, setup.dependencies),
		(error) => error.code === "pull-ambiguous",
	);
	assert.equal(setup.puts.length, 0);
	const state = await readState(setup.gitCommonDir);
	assert.equal(state.pullUri, undefined);
});

test("pr --update appends exactly one round with CAS and preserves fields", async (t) => {
	const existing = {
		cid: "bafcurrent0",
		value: {
			$type: PULL_COLLECTION,
			title: "original title",
			body: "original body",
			source: { branch: "feature" },
			target: { repo: KNOT_DID, branch: "main", repoDid: KNOT_DID },
			createdAt: "2026-07-01T00:00:00.000Z",
			rounds: [{ createdAt: "2026-07-01T00:00:00.000Z", patchBlob: { $type: "blob" } }],
		},
	};
	const pulls = new Map([["pull1", existing]]);
	const setup = await setupPr(t, { pulls });
	const result = await pr({ json: true, update: true }, setup.dependencies);
	assert.equal(result.outcome, "refreshed");
	const written = setup.puts[0];
	assert.equal(written.swapRecord, "bafcurrent0");
	assert.equal(written.record.rounds.length, 2);
	assert.equal(written.record.title, "original title");
	assert.equal(written.record.createdAt, "2026-07-01T00:00:00.000Z");
});

test("pr --update fails when there is no pull to update", async (t) => {
	const setup = await setupPr(t);
	await assert.rejects(
		pr({ json: true, update: true }, setup.dependencies),
		(error) => error.code === "pull-missing",
	);
	assert.equal(setup.puts.length, 0);
});

test("pr fails on an empty outgoing range before uploading a blob", async (t) => {
	const setup = await setupPr(t);
	// Point the pushed tip at the base commit so the range is empty.
	await writeRepoState(setup.gitCommonDir, {
		lastPushedBranch: "feature",
		lastPushedTip: setup.base,
	});
	await assert.rejects(
		pr({ json: true }, setup.dependencies),
		(error) => error.code === "outgoing-range-empty",
	);
	assert.equal(setup.uploads.length, 0);
	assert.equal(setup.puts.length, 0);
});

test("pr rendered-URL timeout persists the pull and reports the AT-URI, then a rerun resolves it", async (t) => {
	const setup = await setupPr(t, { converge: false });
	await assert.rejects(pr({ json: true }, setup.dependencies), (error) => {
		return (
			error.code === "rendered-url-unresolved" &&
			typeof error.hint === "string" &&
			error.hint.includes(setup.pullUri)
		);
	});
	const afterTimeout = await readState(setup.gitCommonDir);
	assert.equal(afterTimeout.pullUri, setup.pullUri);
	assert.equal(afterTimeout.renderedPullUrl, undefined);

	// Rerun with a converging appview: adopts the same pull (no duplicate) and resolves.
	setup.dependencies.fetch = renderFetch({
		owner: ROOK_DID,
		repoSlug: REPO_NAME,
		id: 7,
		pullUri: setup.pullUri,
	});
	const result = await pr({ json: true }, setup.dependencies);
	assert.equal(result.outcome, "adopted");
	assert.equal(setup.pulls.size, 1);
	const resolved = await readState(setup.gitCommonDir);
	assert.equal(resolved.renderedPullUrl, `${APPVIEW}/${ROOK_DID}/${REPO_NAME}/pulls/7`);
});

function matchingPullValue() {
	return {
		$type: PULL_COLLECTION,
		title: "feature → main",
		source: { branch: "feature" },
		target: { repo: KNOT_DID, branch: "main", repoDid: KNOT_DID },
		createdAt: "2026-07-01T00:00:00.000Z",
		rounds: [{ createdAt: "2026-07-01T00:00:00.000Z", patchBlob: { $type: "blob" } }],
	};
}

test("submit-mode pr adopts without appending when the pushed tip is unchanged", async (t) => {
	const pulls = new Map([["pull1", { cid: "bafexisting0", value: matchingPullValue() }]]);
	const setup = await setupPr(t, { pulls });
	await writeRepoState(setup.gitCommonDir, {
		pullUri: setup.pullUri,
		pullRkey: "pull1",
		pullCid: "bafexisting0",
		pullCreatedAt: "2026-07-01T00:00:00.000Z",
		pullRoundTip: setup.tip,
	});
	const result = await pr({ json: true, appendWhenExists: true }, setup.dependencies);
	assert.equal(result.outcome, "adopted");
	assert.equal(setup.puts.length, 0, "no redundant round appended on an unchanged tip");
});

test("submit-mode pr appends a round when the pushed tip advanced", async (t) => {
	const pulls = new Map([["pull1", { cid: "bafexisting0", value: matchingPullValue() }]]);
	const setup = await setupPr(t, { pulls });
	await writeRepoState(setup.gitCommonDir, {
		pullUri: setup.pullUri,
		pullRkey: "pull1",
		pullCid: "bafexisting0",
		pullCreatedAt: "2026-07-01T00:00:00.000Z",
		pullRoundTip: "b".repeat(40),
	});
	const result = await pr({ json: true, appendWhenExists: true }, setup.dependencies);
	assert.equal(result.outcome, "refreshed");
	assert.equal(setup.puts.length, 1);
	const state = await readState(setup.gitCommonDir);
	assert.equal(state.pullRoundTip, setup.tip);
});

test("prCore with a provided context skips its own restore and promotion", async (t) => {
	const setup = await setupPr(t);
	const context = await setup.dependencies.restoreContext();
	const before = setup.calls.promotes;
	const result = await prCore({ json: true }, context, setup.dependencies);
	assert.equal(result.outcome, "created");
	assert.equal(setup.calls.promotes, before, "submit owns promotion, not the core");
});

test("pr recovers after a durable write then a state-persist failure without duplicating", async (t) => {
	const setup = await setupPr(t);
	let calls = 0;
	setup.dependencies.writeRepoState = async (dir, patch, deps) => {
		calls += 1;
		if (calls === 1) throw Object.assign(new Error("disk full"), { code: "state-write-failed" });
		return writeRepoState(dir, patch, deps);
	};
	await assert.rejects(
		pr({ json: true }, setup.dependencies),
		(error) => error.code === "state-write-failed",
	);
	assert.equal(setup.pulls.size, 1, "the durable pull record was created");

	// Rerun without local pull state: rediscovers the created pull instead of duplicating.
	setup.dependencies.writeRepoState = undefined;
	const result = await pr({ json: true }, setup.dependencies);
	assert.equal(result.outcome, "adopted");
	assert.equal(setup.pulls.size, 1);
});
