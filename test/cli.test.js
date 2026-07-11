// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { createProgram } from "../src/cli.js";
import { writeIdentity } from "../src/lib/identity.js";
import { temporaryHome, testIdentity } from "./helpers.js";

function run(args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [path.resolve("bin/rook.js"), ...args], {
			...options,
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

test("real rook help begins with exact banner and lists commands", async () => {
	const result = await run(["--help"]);
	assert.equal(result.code, 0);
	assert.equal(result.stdout.split(/\r?\n/)[0], "rook ✦ on the job");
	for (const command of ["enroll", "login", "fork", "push", "whoami", "doctor"])
		assert.match(result.stdout, new RegExp(command));
	const doctor = createProgram().commands.find((command) => command.name() === "doctor");
	assert.equal(
		doctor.description(),
		"run read-only identity, authentication, and repository push-readiness diagnostics",
	);
});

test("global identity before subcommand wins over environment", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	const selected = path.join(home.directory, "selected.json");
	await writeIdentity(selected, await testIdentity());
	const result = await run(["--identity", selected, "whoami", "--json"], {
		env: {
			...process.env,
			...home.env,
			ROOK_IDENTITY_FILE: path.join(home.directory, "wrong.json"),
		},
	});
	assert.equal(result.code, 0);
	assert.equal(result.stderr, "");
	assert.equal(JSON.parse(result.stdout).identityPath, selected);
	const program = createProgram();
	assert.equal(program.options.filter(({ long }) => long === "--identity").length, 1);
	for (const command of program.commands) {
		assert.equal(
			command.options.some(({ long }) => long === "--identity"),
			false,
		);
	}
});
