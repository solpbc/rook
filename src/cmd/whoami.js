// SPDX-License-Identifier: AGPL-3.0-only

import { RookError } from "../lib/error-format.js";
import { publicIdentity, readIdentity } from "../lib/identity.js";
import { createOutput } from "../lib/json-output.js";
import { deriveIdentityPaths, resolveIdentityPath } from "../lib/paths.js";
import { readJsonFile } from "../lib/storage.js";

export async function whoami(options, dependencies = {}) {
	const identityPath = resolveIdentityPath(options, dependencies.env, dependencies.cwd);
	let identity;
	try {
		identity = await (dependencies.readIdentity ?? readIdentity)(identityPath);
	} catch (cause) {
		throw new RookError("selected identity is malformed", { cause });
	}
	if (!identity) throw new RookError("no identity is enrolled at the selected path");
	const { sessionPath } = deriveIdentityPaths(identityPath);
	let sessionStatus;
	try {
		const session = await readJsonFile(sessionPath, dependencies.fs);
		sessionStatus = session === undefined ? "absent" : "present";
	} catch {
		sessionStatus = "malformed";
	}
	const details = {
		absent: "session file is absent; live validity was not checked",
		present: "session file is present; live validity was not checked",
		malformed: "session file is malformed or unreadable; live validity was not checked",
	};
	return {
		...publicIdentity(identity, identityPath),
		session: {
			status: sessionStatus,
			verified: false,
			detail: details[sessionStatus],
		},
	};
}

export function register(program, dependencies = {}) {
	program
		.command("whoami")
		.description("show the selected local identity")
		.option("--json", "emit structured JSON")
		.action(async (localOptions, command) => {
			const output = createOutput({ ...dependencies, json: localOptions.json });
			try {
				const result = await whoami(command.optsWithGlobals(), dependencies);
				output.success(result, `${result.handle} (${result.did}); ${result.session.detail}.`);
			} catch (error) {
				output.failure(error);
				process.exitCode = 1;
			}
		});
}
