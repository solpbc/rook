// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

function run(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [path.resolve("bin/rook.js"), ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

for (const json of [false, true]) {
	for (const kind of ["command", "option"]) {
		test(`${json ? "JSON" : "human"} parse errors redact a secret-bearing unknown ${kind}`, async () => {
			const raw = `UNIQUE-${kind}-${json ? "JSON" : "HUMAN"}-CANARY`;
			const encoded = Buffer.from(raw).toString("base64url");
			const secret = `https://rook.invalid/roost#${raw}.${encoded}`;
			const args =
				kind === "command"
					? [secret, ...(json ? ["--json"] : [])]
					: ["enroll", ...(json ? ["--json"] : []), `--unknown=${secret}`];
			const result = await run(args);
			assert.equal(result.code, 1);
			for (const output of [result.stdout, result.stderr]) {
				assert.doesNotMatch(output, new RegExp(raw));
				assert.doesNotMatch(output, new RegExp(encoded));
			}
			if (json) {
				assert.equal(result.stderr, "");
				assert.equal(JSON.parse(result.stdout).ok, false);
			} else {
				assert.equal(result.stdout, "");
				assert.match(result.stderr, /\[REDACTED\]/);
			}
		});
	}
}
