// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";
import { submit } from "../src/cmd/submit.js";
import { RookError } from "../src/lib/error-format.js";

const ROOK_DID = "did:plc:testrook";
const UPSTREAM = "https://github.com/owner/widget.git";

function baseResults() {
	return {
		fork: {
			knotRepoDid: "did:plc:knot",
			record: { outcome: "created" },
			remote: { outcome: "created" },
		},
		push: { branch: "feature", tip: "a".repeat(40) },
		pr: {
			outcome: "created",
			pullUri: "at://did:plc:testrook/sh.tangled.repo.pull/p1",
			renderedPullUrl: "https://tangled.org/x/y/pulls/1",
		},
		ship: {
			outcome: "created",
			capUri: "at://did:plc:testrook/org.v-it.cap/c1",
			capRef: "rook-aaaaaa-bbbbbb",
		},
	};
}

function setup({
	results = baseResults(),
	throwers = {},
	restoreThrows = null,
	identity = { did: ROOK_DID },
} = {}) {
	const calls = { restores: 0, promotes: 0, rollbacks: 0, cores: [], contexts: [], opts: {} };
	const context = {
		identity,
		knot: { host: "knot.rook.host" },
		session: { did: ROOK_DID },
		info: { sub: ROOK_DID },
		agent: { did: ROOK_DID },
		transaction: {
			promote: async () => {
				calls.promotes += 1;
			},
			rollback: async () => {
				calls.rollbacks += 1;
			},
		},
	};
	const makeCore = (name) => async (opts, ctx) => {
		calls.cores.push(name);
		calls.contexts.push(ctx);
		calls.opts[name] = opts;
		if (throwers[name]) throw throwers[name];
		return results[name];
	};
	const dependencies = {
		env: {},
		readIdentity: async () => identity,
		restoreContext: async () => {
			calls.restores += 1;
			if (restoreThrows) throw restoreThrows;
			return context;
		},
		forkCore: makeCore("fork"),
		pushCore: makeCore("push"),
		prCore: makeCore("pr"),
		shipCore: makeCore("ship"),
	};
	return { calls, context, dependencies };
}

test("submit runs every stage under one restored, promoted session", async () => {
	const { calls, context, dependencies } = setup();
	const summary = await submit({ upstream: UPSTREAM, identity: "/id.json" }, dependencies);
	assert.equal(summary.ok, true);
	assert.deepEqual(calls.cores, ["fork", "push", "pr", "ship"]);
	assert.equal(calls.restores, 1);
	assert.equal(calls.promotes, 1);
	// Every stage shares the one restored context.
	assert.ok(calls.contexts.every((ctx) => ctx === context));
	assert.equal(summary.stages.fork.status, "completed");
	assert.equal(summary.stages.pr.pull, "created");
	assert.equal(summary.stages.ship.capRef, "rook-aaaaaa-bbbbbb");
	// pr appends a round on submit, push is silenced, ship carries the request.
	assert.equal(calls.opts.pr.appendWhenExists, true);
	assert.equal(calls.opts.push.json, true);
});

test("submit stops at the first failure and never reports a later stage completed", async () => {
	const { calls, dependencies } = setup({
		throwers: {
			push: new RookError("remote branch tip does not match the local tip", {
				stage: "verify",
				code: "remote-tip-mismatch",
				remediation: "run rook push",
			}),
		},
	});
	const summary = await submit({ upstream: UPSTREAM, identity: "/id.json" }, dependencies);
	assert.equal(summary.ok, false);
	assert.equal(summary.stage, "push");
	assert.equal(summary.code, "remote-tip-mismatch");
	assert.equal(summary.recovery, "run rook push");
	assert.equal(summary.stages.fork.status, "completed");
	assert.equal(summary.stages.push.status, "failed");
	assert.equal(summary.stages.push.code, "remote-tip-mismatch");
	assert.equal(summary.stages.pr.status, "skipped");
	assert.equal(summary.stages.ship.status, "skipped");
	assert.deepEqual(calls.cores, ["fork", "push"]);
});

test("submit redacts a token reflected in a stage error", async () => {
	const leak = "eyJhbGciOiJ9.payloadsegment.signaturesegment";
	const { dependencies } = setup({
		throwers: {
			fork: new RookError(`knot rejected auth ${leak}`, { code: "repo-create-rejected" }),
		},
	});
	const summary = await submit({ upstream: UPSTREAM, identity: "/id.json" }, dependencies);
	assert.equal(summary.ok, false);
	assert.ok(!JSON.stringify(summary).includes(leak), "no token in the JSON summary");
	assert.equal(summary.stages.fork.status, "failed");
});

test("submit folds a pre-stage session failure into the fork stage", async () => {
	const { calls, dependencies } = setup({
		restoreThrows: new RookError("stored OAuth session is invalid or unrefreshable", {
			stage: "session",
			code: "session-invalid",
			remediation: "run rook login",
		}),
	});
	const summary = await submit({ upstream: UPSTREAM, identity: "/id.json" }, dependencies);
	assert.equal(summary.ok, false);
	assert.equal(summary.stage, "fork");
	assert.equal(summary.stages.fork.code, "session-invalid");
	assert.equal(summary.stages.push.status, "skipped");
	assert.equal(calls.cores.length, 0, "no stage cores ran");
	assert.equal(calls.promotes, 0);
});

test("submit reports a missing identity as a fork failure", async () => {
	const { calls, dependencies } = setup({ identity: null });
	const summary = await submit({ upstream: UPSTREAM, identity: "/id.json" }, dependencies);
	assert.equal(summary.ok, false);
	assert.equal(summary.stage, "fork");
	assert.equal(summary.stages.fork.code, "identity-invalid");
	assert.equal(calls.restores, 0);
});
