// SPDX-License-Identifier: AGPL-3.0-only

import path from "node:path";
import envPaths from "env-paths";

export function resolveIdentityPath(opts = {}, env = process.env, cwd = process.cwd()) {
	const selected = opts.identity ?? env.ROOK_IDENTITY_FILE;
	if (selected !== undefined) {
		if (typeof selected !== "string" || selected.trim() === "") {
			throw new TypeError("identity path must not be empty");
		}
		return path.resolve(cwd, selected);
	}
	return path.join(envPaths("rook", { suffix: "" }).config, "identity.json");
}

export function deriveIdentityPaths(identityPath) {
	const extension = path.extname(identityPath);
	const stem = extension ? identityPath.slice(0, -extension.length) : identityPath;
	return {
		identityPath,
		sessionPath: `${stem}.session.json`,
		statePath: `${stem}.state.json`,
	};
}
