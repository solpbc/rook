// SPDX-License-Identifier: AGPL-3.0-only

import path from "node:path";
import envPaths from "env-paths";

function injectedConfigDirectory(env) {
	if (process.platform === "darwin") {
		return path.join(env.HOME, "Library", "Preferences", "rook");
	}
	if (process.platform === "win32") {
		return path.join(env.APPDATA ?? path.join(env.HOME, "AppData", "Roaming"), "rook", "Config");
	}
	return path.join(env.XDG_CONFIG_HOME ?? path.join(env.HOME, ".config"), "rook");
}

export function resolveIdentityPath(opts = {}, env = process.env, cwd = process.cwd()) {
	const selected = opts.identity ?? env.ROOK_IDENTITY_FILE;
	if (selected !== undefined) {
		if (typeof selected !== "string" || selected.trim() === "") {
			throw new TypeError("identity path must not be empty");
		}
		return path.resolve(cwd, selected);
	}
	const config =
		env === process.env ? envPaths("rook", { suffix: "" }).config : injectedConfigDirectory(env);
	return path.join(config, "identity.json");
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
