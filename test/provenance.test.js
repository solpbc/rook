// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";
import { findProvenanceOffenders, provenanceRepairSteps } from "../src/lib/provenance.js";

const DID = "did:plc:testrook";

function row(authorEmail, committerEmail, hash = "a".repeat(40)) {
	return { hash, authorEmail, committerEmail };
}

test("provenance offenders require byte-exact author and committer DID emails", () => {
	const exact = row(DID, DID);
	const offenders = [
		row(DID.toUpperCase(), DID, "b".repeat(40)),
		row(`${DID}.extra`, DID, "c".repeat(40)),
		row(`${DID} display`, DID, "d".repeat(40)),
		row(DID, "wrong@example.invalid", "e".repeat(40)),
	];
	assert.deepEqual(findProvenanceOffenders([exact], DID), []);
	assert.deepEqual(findProvenanceOffenders([exact, ...offenders], DID), offenders);
});

test("provenance repair guidance is concrete and non-destructive until explicitly followed", () => {
	const steps = provenanceRepairSteps(DID, "base-sha");
	assert.match(steps, new RegExp(`git config user.email '${DID}'`));
	assert.match(steps, /git rebase -i base-sha/);
	assert.match(steps, /review the rewritten history/);
});
