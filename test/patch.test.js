// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { formatPatch } from "../src/lib/patch.js";
import { temporaryGitRepository } from "./helpers.js";

test("produces deterministic gzipped format-patch bytes for the outgoing range", async (t) => {
	const repo = await temporaryGitRepository();
	t.after(repo.cleanup);
	const base = await repo.commit({ message: "base" });
	await repo.commit({ message: "one" });
	const tip = await repo.commit({ message: "two" });

	const first = await formatPatch(repo.directory, base, tip);
	const second = await formatPatch(repo.directory, base, tip);
	assert.equal(Buffer.compare(first, second), 0, "same tips must yield identical bytes");

	const text = gunzipSync(first).toString("utf8");
	assert.match(text, /^From [0-9a-f]{40} Mon Sep 17 00:00:00 2001/m);
	assert.equal((text.match(/^From [0-9a-f]{40} /gm) ?? []).length, 2);
	assert.match(text, /Subject: \[PATCH 1\/2\] one/);
	assert.match(text, /Subject: \[PATCH 2\/2\] two/);
	// --no-signature drops git's version-dependent trailer for cross-version determinism.
	assert.doesNotMatch(text, /\n-- \n/);
});

test("fails closed on an empty outgoing range before producing bytes", async (t) => {
	const repo = await temporaryGitRepository();
	t.after(repo.cleanup);
	const base = await repo.commit({ message: "base" });
	await assert.rejects(
		formatPatch(repo.directory, base, base),
		(error) => error.code === "outgoing-range-empty" && typeof error.remediation === "string",
	);
});

test("represents a merge-containing history deterministically", async (t) => {
	const repo = await temporaryGitRepository();
	t.after(repo.cleanup);
	const base = await repo.commit({ message: "base" });
	await repo.run(["checkout", "-q", "-b", "feature"]);
	await repo.commit({ message: "feature-1" });
	await repo.run(["checkout", "-q", "main"]);
	await repo.commit({ message: "main-1" });
	await repo.run(["merge", "--no-ff", "-q", "-m", "merge feature", "feature"]);
	const tip = (await repo.run(["rev-parse", "HEAD"])).stdout.trim();

	const first = await formatPatch(repo.directory, base, tip);
	const second = await formatPatch(repo.directory, base, tip);
	assert.equal(Buffer.compare(first, second), 0);
	const text = gunzipSync(first).toString("utf8");
	// The two non-merge commits are represented; the merge commit is omitted.
	assert.match(text, /Subject: .*feature-1/);
	assert.match(text, /Subject: .*main-1/);
	assert.doesNotMatch(text, /merge feature/);
});
