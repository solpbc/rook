// SPDX-License-Identifier: AGPL-3.0-only

import { createRequire } from "node:module";
import { Command } from "commander";
import { register as registerDoctor } from "./cmd/doctor.js";
import { register as registerEnroll } from "./cmd/enroll.js";
import { register as registerLogin } from "./cmd/login.js";
import { register as registerWhoami } from "./cmd/whoami.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

export function createProgram(dependencies = {}) {
	const program = new Command();
	program
		.name("rook")
		.description("agent-native identity and authentication for rook.host")
		.version(version)
		.option("--identity <path>", "select an identity file")
		.addHelpText("beforeAll", "rook ✦ on the job");
	registerEnroll(program, dependencies);
	registerLogin(program, dependencies);
	registerWhoami(program, dependencies);
	registerDoctor(program, dependencies);
	return program;
}

export const program = createProgram();
