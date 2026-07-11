// SPDX-License-Identifier: AGPL-3.0-only

import { execFile } from "node:child_process";
import { RookError } from "./error-format.js";
import { redactText } from "./redact.js";

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const OBJECT_ID = /^[0-9a-f]{40}$/;
const ENCODED_SEPARATOR = /%(?:2f|5c)/i;

function repositoryUrlError(message, code = "upstream-url-invalid") {
	return new RookError(message, { code });
}

function rejectCredentials() {
	throw repositoryUrlError(
		"repository URL contains unsupported credentials",
		"upstream-credentials-rejected",
	);
}

function hasControlCharacter(value) {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function validateRawUrl(input) {
	if (
		typeof input !== "string" ||
		input.length === 0 ||
		input.trim() !== input ||
		hasControlCharacter(input) ||
		input.includes("\\") ||
		ENCODED_SEPARATOR.test(input)
	) {
		throw repositoryUrlError("repository URL is invalid");
	}
}

function parseRepositoryUrl(input) {
	validateRawUrl(input);
	const scp = /^git@([^:/?#\s]+):([^?#]+)$/.exec(input);
	if (scp) {
		const sourcePath = `/${scp[2].replace(/^\/+/, "")}`;
		return { host: scp[1].toLowerCase(), sourcePath };
	}
	if (!input.includes("://") && /^[^@\s]+@[^:\s]+:/.test(input)) rejectCredentials();

	let url;
	try {
		url = new URL(input);
	} catch {
		throw repositoryUrlError("repository URL is invalid");
	}
	if (url.search !== "" || url.hash !== "") {
		throw repositoryUrlError("repository URL must not contain a query or fragment");
	}
	if (url.protocol === "https:") {
		if (url.username !== "" || url.password !== "") rejectCredentials();
	} else if (url.protocol === "ssh:") {
		if (url.password !== "" || (url.username !== "" && url.username !== "git")) {
			rejectCredentials();
		}
	} else {
		throw repositoryUrlError("repository URL scheme is unsupported");
	}
	if (url.hostname === "") throw repositoryUrlError("repository URL host is missing");
	const defaultPort =
		(url.protocol === "https:" && url.port === "443") ||
		(url.protocol === "ssh:" && url.port === "22");
	const port = defaultPort || url.port === "" ? "" : `:${url.port}`;
	return { host: `${url.hostname.toLowerCase()}${port}`, sourcePath: url.pathname };
}

function identityPath(sourcePath) {
	let value = sourcePath.replace(/^\/+/, "").replace(/\/+$/, "");
	if (value.endsWith(".git")) value = value.slice(0, -4);
	if (value.length === 0) throw repositoryUrlError("repository URL path is missing");
	return value;
}

function executeGit(args, options, dependencies) {
	const runner = dependencies.runGit ?? runGit;
	return runner(args, options, dependencies);
}

function failedGit(message, result, options = {}) {
	return new RookError(message, {
		...options,
		...(result.stderr ? { cause: new Error(result.stderr.trim()) } : {}),
	});
}

function requireSuccessful(result, message) {
	if (result.status !== 0) throw failedGit(message, result);
	return result;
}

export function normalizeRepoIdentity(input) {
	const parsed = parseRepositoryUrl(input);
	return `${parsed.host}/${identityPath(parsed.sourcePath)}`;
}

export function canonicalRepoSource(input) {
	const parsed = parseRepositoryUrl(input);
	identityPath(parsed.sourcePath);
	const sourcePath = `/${parsed.sourcePath.replace(/^\/+/, "")}`;
	return `https://${parsed.host}${sourcePath}`;
}

export function buildGitAuthEnv(remoteUrl, token, baseEnv = process.env) {
	parseRepositoryUrl(remoteUrl);
	if (typeof token !== "string" || token.length === 0) {
		throw new RookError("service authorization token is missing", {
			code: "service-auth-rejected",
		});
	}
	return {
		...baseEnv,
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: `http.${remoteUrl}.extraHeader`,
		GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
		GIT_TERMINAL_PROMPT: "0",
	};
}

export function runGit(args, options = {}, dependencies = {}) {
	const maxBuffer = dependencies.maxGitOutputBytes ?? DEFAULT_MAX_BUFFER;
	return new Promise((resolve, reject) => {
		const execOptions = {
			cwd: options.cwd,
			env: options.env ?? dependencies.env ?? process.env,
			encoding: "utf8",
			maxBuffer,
			shell: false,
			...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
		};
		const callback = (error, stdout = "", stderr = "") => {
			const safeStdout = redactText(stdout);
			const safeStderr = redactText(stderr);
			if (!error) {
				resolve({ status: 0, stdout: safeStdout, stderr: safeStderr });
				return;
			}
			if (
				error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
				/maxBuffer length exceeded/i.test(error.message)
			) {
				reject(new RookError("git output exceeded the configured limit"));
				return;
			}
			if (typeof error.code !== "number" && !error.killed) {
				reject(new RookError("git could not be executed"));
				return;
			}
			const result = {
				status: typeof error.code === "number" ? error.code : 1,
				stdout: safeStdout,
				stderr: safeStderr,
			};
			if (options.allowFailure) resolve(result);
			else reject(failedGit("git command failed", result));
		};
		try {
			execFile("git", args, execOptions, callback);
		} catch {
			reject(new RookError("git could not be executed"));
		}
	});
}

export async function resolveGitCommonDir(cwd, dependencies = {}) {
	const result = requireSuccessful(
		await executeGit(
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			{ cwd },
			dependencies,
		),
		"could not resolve the Git common directory",
	);
	const value = result.stdout.trim();
	if (value === "") throw new RookError("Git returned an empty common directory");
	return value;
}

export async function getRemoteUrl(cwd, name, dependencies = {}) {
	const result = await executeGit(
		["remote", "get-url", name],
		{ cwd, allowFailure: true },
		dependencies,
	);
	if (result.status === 2) return undefined;
	requireSuccessful(result, "could not read Git remote URL");
	const value = result.stdout.trim();
	if (value === "") throw new RookError("Git returned an empty remote URL");
	return value;
}

export async function currentBranch(cwd, dependencies = {}) {
	const result = await executeGit(
		["symbolic-ref", "-q", "--short", "HEAD"],
		{ cwd, allowFailure: true },
		dependencies,
	);
	if (result.status === 1) return undefined;
	requireSuccessful(result, "could not resolve the current Git branch");
	const branch = result.stdout.trim();
	if (branch === "") throw new RookError("Git returned an empty branch name");
	return branch;
}

export async function validateBranchName(cwd, branch, dependencies = {}) {
	if (typeof branch !== "string" || branch.length === 0) {
		throw new RookError("Git branch name is invalid", { code: "branch-invalid" });
	}
	const result = await executeGit(
		["check-ref-format", `refs/heads/${branch}`],
		{ cwd, allowFailure: true },
		dependencies,
	);
	if (result.status !== 0) {
		throw new RookError("Git branch name is invalid", { code: "branch-invalid" });
	}
	return branch;
}

export async function remoteHeadBranch(cwd, remote, dependencies = {}) {
	const result = await executeGit(
		["symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`],
		{ cwd, allowFailure: true },
		dependencies,
	);
	if (result.status === 1) return undefined;
	requireSuccessful(result, "could not resolve the remote default branch");
	const value = result.stdout.trim();
	const prefix = `${remote}/`;
	if (!value.startsWith(prefix) || value.length === prefix.length) {
		throw new RookError("remote HEAD did not resolve to the requested remote", {
			code: "default-branch-missing",
		});
	}
	return value.slice(prefix.length);
}

export async function resolveCommit(cwd, revision, dependencies = {}) {
	const result = await executeGit(
		["rev-parse", "--verify", "--quiet", `${revision}^{commit}`],
		{ cwd, allowFailure: true },
		dependencies,
	);
	if (result.status !== 0) {
		throw new RookError(revision === "HEAD" ? "HEAD has no commit" : "Git revision is missing", {
			code: revision === "HEAD" ? "head-unborn" : "base-ref-missing",
		});
	}
	const objectId = result.stdout.trim();
	if (!OBJECT_ID.test(objectId)) throw new RookError("Git returned an invalid commit object ID");
	return objectId;
}

export async function enumerateProvenance(cwd, base, tip, dependencies = {}) {
	const result = requireSuccessful(
		await executeGit(
			["log", "--reverse", "--format=%H%x09%ae%x09%ce", `${base}..${tip}`],
			{ cwd },
			dependencies,
		),
		"could not enumerate outgoing commits",
	);
	if (result.stdout === "") return [];
	return result.stdout
		.split(/\r?\n/)
		.filter((line) => line !== "")
		.map((line) => {
			const fields = line.split("\t");
			if (fields.length !== 3 || !OBJECT_ID.test(fields[0])) {
				throw new RookError("Git returned malformed commit provenance");
			}
			return { hash: fields[0], authorEmail: fields[1], committerEmail: fields[2] };
		});
}

export async function lsRemoteRef(
	cwd,
	remoteOrUrl,
	fullRef,
	authEnv = process.env,
	dependencies = {},
) {
	const result = await executeGit(
		["ls-remote", remoteOrUrl, fullRef],
		{ cwd, env: authEnv, allowFailure: true },
		dependencies,
	);
	if (result.status !== 0) {
		throw failedGit("could not verify the remote ref", result, { code: "push-rejected" });
	}
	const rows = result.stdout.split(/\r?\n/).filter((line) => line !== "");
	if (rows.length === 0) {
		throw new RookError("remote ref is missing", { code: "remote-ref-missing" });
	}
	if (rows.length !== 1) {
		throw new RookError("remote ref result is ambiguous", { code: "remote-ref-ambiguous" });
	}
	const fields = rows[0].split("\t");
	if (fields.length !== 2 || !OBJECT_ID.test(fields[0]) || fields[1] !== fullRef) {
		throw new RookError("remote ref result is ambiguous", { code: "remote-ref-ambiguous" });
	}
	return fields[0];
}

export async function ensureRemoteUrl(cwd, name, wanted, dependencies = {}) {
	normalizeRepoIdentity(wanted);
	const existing = await getRemoteUrl(cwd, name, dependencies);
	if (existing === undefined) {
		requireSuccessful(
			await executeGit(["remote", "add", name, wanted], { cwd }, dependencies),
			"could not add Git remote",
		);
		return { outcome: "created", url: wanted };
	}
	if (existing === wanted) return { outcome: "unchanged", url: wanted };
	let sameIdentity = false;
	try {
		sameIdentity = normalizeRepoIdentity(existing) === normalizeRepoIdentity(wanted);
	} catch {
		throw new RookError("existing Git remote conflicts with the requested repository", {
			code: "remote-conflict",
		});
	}
	if (!sameIdentity) {
		throw new RookError("existing Git remote conflicts with the requested repository", {
			code: "remote-conflict",
		});
	}
	requireSuccessful(
		await executeGit(["remote", "set-url", name, wanted], { cwd }, dependencies),
		"could not update Git remote",
	);
	return { outcome: "updated", url: wanted };
}

export async function pushRef(
	cwd,
	remote,
	localRef,
	remoteRef,
	authEnv,
	options = {},
	dependencies = {},
) {
	return executeGit(
		["push", "--progress", remote, `${localRef}:${remoteRef}`],
		{
			cwd,
			env: authEnv,
			allowFailure: true,
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		},
		dependencies,
	);
}
