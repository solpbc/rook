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
	let session;
	let restorable = false;
	try {
		session = await readJsonFile(sessionPath, dependencies.fs);
		restorable = Boolean(
			session &&
				Object.hasOwn(session, identity.did) &&
				session[identity.did]?.dpopJwk &&
				session[identity.did]?.tokenSet,
		);
	} catch {
		session = {};
	}
	return {
		...publicIdentity(identity, identityPath),
		session: {
			present: session !== undefined,
			restorable,
			verified: false,
			detail: restorable
				? "local session material exists; live validity was not checked"
				: "no locally restorable session; live validity was not checked",
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
