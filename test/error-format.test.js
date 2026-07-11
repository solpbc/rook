// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";
import { RookError, formatError } from "../src/lib/error-format.js";
import { createOutput } from "../src/lib/json-output.js";
import { memoryStream } from "./helpers.js";

test("structured RookError fields round-trip through JSON output", () => {
	const stdout = memoryStream();
	const stderr = memoryStream();
	const output = createOutput({ stdout, stderr, json: true });
	output.failure(
		new RookError("push failed", {
			stage: "verify",
			code: "remote-tip-mismatch",
			remediation: "run rook push",
		}),
	);
	assert.deepEqual(JSON.parse(stdout.toString()), {
		ok: false,
		error: "push failed",
		stage: "verify",
		code: "remote-tip-mismatch",
		remediation: "run rook push",
	});
	assert.equal(stderr.toString(), "");
});

test("human errors label structured fields before causes and hints", () => {
	const stdout = memoryStream();
	const stderr = memoryStream();
	const output = createOutput({ stdout, stderr });
	output.failure(
		new RookError("push failed", {
			stage: "push",
			code: "push-rejected",
			remediation: "run rook push",
			cause: new Error("remote rejected"),
			hint: "inspect the remote",
		}),
	);
	assert.equal(stdout.toString(), "");
	assert.equal(
		stderr.toString(),
		[
			"push failed",
			"stage: push",
			"code: push-rejected",
			"remediation: run rook push",
			"caused by: remote rejected",
			"hint: inspect the remote",
			"",
		].join("\n"),
	);
});

test("plain errors retain the existing minimal shape", () => {
	assert.deepEqual(formatError(new Error("plain failure")), { error: "plain failure" });
});

test("structured errors still redact secrets in messages and causes", () => {
	const formatted = formatError(
		new RookError("Authorization: Bearer MESSAGE-SECRET-1234567890", {
			stage: "mint",
			code: "service-auth-rejected",
			remediation: "run rook login",
			cause: new Error("Authorization: Bearer CAUSE-SECRET-123456789012"),
		}),
	);
	const serialized = JSON.stringify(formatted);
	assert.doesNotMatch(serialized, /MESSAGE-SECRET/);
	assert.doesNotMatch(serialized, /CAUSE-SECRET/);
	assert.match(serialized, /\[REDACTED\]/);
});
