// SPDX-License-Identifier: AGPL-3.0-only

import { createRequire } from "node:module";
import { Command, CommanderError } from "commander";
import { register as registerDoctor } from "./cmd/doctor.js";
import { register as registerEnroll } from "./cmd/enroll.js";
import { register as registerFork } from "./cmd/fork.js";
import { register as registerLogin } from "./cmd/login.js";
import { register as registerPush } from "./cmd/push.js";
import { register as registerWhoami } from "./cmd/whoami.js";
import { createOutput } from "./lib/json-output.js";
import { redactText } from "./lib/redact.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

export function createProgram(dependencies = {}) {
	const stdout = dependencies.stdout ?? process.stdout;
	const stderr = dependencies.stderr ?? process.stderr;
	const program = new Command();
	program
		.name("rook")
		.description("agent-native identity and authentication for rook.host")
		.version(version)
		.option("--identity <path>", "select an identity file")
		.addHelpText("beforeAll", "rook ✦ on the job")
		.configureOutput({
			writeOut: (value) => stdout.write(redactText(value)),
			writeErr: (value) => {
				if (!dependencies.suppressCommanderErrors) stderr.write(redactText(value));
			},
		})
		.exitOverride();
	registerEnroll(program, dependencies);
	registerLogin(program, dependencies);
	registerFork(program, dependencies);
	registerPush(program, dependencies);
	registerWhoami(program, dependencies);
	registerDoctor(program, dependencies);
	return program;
}

export async function runCli(argv = process.argv, dependencies = {}) {
	const json = argv.includes("--json");
	const program = createProgram({ ...dependencies, suppressCommanderErrors: json });
	try {
		await program.parseAsync(argv);
	} catch (error) {
		if (!(error instanceof CommanderError)) throw error;
		if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return 0;
		if (json) {
			createOutput({ ...dependencies, json: true }).failure(new Error(redactText(error.message)));
		}
		return error.exitCode || 1;
	}
	return process.exitCode ?? 0;
}
