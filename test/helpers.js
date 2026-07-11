// SPDX-License-Identifier: AGPL-3.0-only

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { generateRsa4096, pemToJwk } from "../src/lib/welcome-mat.js";

const execFileAsync = promisify(execFile);

let keysPromise;

export function testKeys() {
	keysPromise ??= generateRsa4096();
	return keysPromise;
}

export async function testIdentity(overrides = {}) {
	const keys = await testKeys();
	return {
		version: 1,
		did: "did:plc:testrook",
		handle: "test.rook.invalid",
		serviceOrigin: "https://rook.invalid",
		rsaPrivateKeyPem: keys.privateKey,
		rsaPublicJwk: pemToJwk(keys.publicKey),
		createdAt: "2026-01-02T03:04:05.000Z",
		...overrides,
	};
}

export async function temporaryHome() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rook-test-"));
	return {
		directory,
		env: {
			HOME: directory,
			XDG_CONFIG_HOME: path.join(directory, "config"),
			ROOK_IDENTITY_FILE: path.join(directory, "identity.json"),
		},
		async cleanup() {
			await fs.rm(directory, { recursive: true, force: true });
		},
	};
}

export function memoryStream() {
	let value = "";
	return {
		write(chunk) {
			value += chunk;
		},
		toString() {
			return value;
		},
	};
}

export async function temporaryGitRepository(options = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "rook-git-test-"));
	const directory = path.join(root, "repo");
	const env = {
		...process.env,
		HOME: root,
		XDG_CONFIG_HOME: path.join(root, "config"),
		GIT_CONFIG_NOSYSTEM: "1",
	};
	async function run(args, runOptions = {}) {
		return execFileAsync("git", args, {
			cwd: runOptions.cwd ?? directory,
			env: { ...env, ...runOptions.env },
			encoding: "utf8",
		});
	}
	await fs.mkdir(directory, { recursive: true });
	await run(["init", "-q", "-b", options.branch ?? "main"]);
	await run(["config", "user.name", options.userName ?? "Rook Test"]);
	await run(["config", "user.email", options.userEmail ?? "rook-test@example.invalid"]);
	const repository = {
		root,
		directory,
		env,
		run,
		async commit(commitOptions = {}) {
			const authorEmail =
				commitOptions.authorEmail ?? options.userEmail ?? "rook-test@example.invalid";
			const committerEmail =
				commitOptions.committerEmail ?? options.userEmail ?? "rook-test@example.invalid";
			await run(["commit", "--allow-empty", "-qm", commitOptions.message ?? "test commit"], {
				env: {
					GIT_AUTHOR_NAME: commitOptions.authorName ?? "Rook Author",
					GIT_AUTHOR_EMAIL: authorEmail,
					GIT_COMMITTER_NAME: commitOptions.committerName ?? "Rook Committer",
					GIT_COMMITTER_EMAIL: committerEmail,
				},
			});
			return (await run(["rev-parse", "HEAD"])).stdout.trim();
		},
		async addLinkedWorktree(name = "linked") {
			const worktree = path.join(root, name);
			await run(["worktree", "add", "-q", "-b", name, worktree]);
			return worktree;
		},
		async cleanup() {
			await fs.rm(root, { recursive: true, force: true });
		},
	};
	if (options.initialCommit) await repository.commit({ message: "initial" });
	return repository;
}
