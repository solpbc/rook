// SPDX-License-Identifier: AGPL-3.0-only

import { RookError } from "../lib/error-format.js";
import { readIdentity } from "../lib/identity.js";
import { createOutput } from "../lib/json-output.js";
import { resolveIdentityPath } from "../lib/paths.js";
import {
	PROFILE_COLLECTION,
	buildProfileRecord,
	canWriteCollection,
	deleteProfile,
	putProfile,
	readProfile,
	readProfileFile,
	recordsEqual,
	scopeError,
	uploadAvatar,
} from "../lib/profile.js";
import { restoreContext } from "../lib/session-context.js";

function firstDefined(...values) {
	for (const value of values) if (value !== undefined) return value;
	return undefined;
}

function collectList(value, previous) {
	const parts = String(value)
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return (previous ?? []).concat(parts);
}

function nowIso(dependencies) {
	return new Date(dependencies.clock?.() ?? Date.now()).toISOString();
}

async function promote(context) {
	let promoted = false;
	try {
		await context.transaction.promote();
		promoted = true;
	} catch (error) {
		throw error instanceof RookError
			? error
			: new RookError("OAuth session could not be promoted", {
					stage: "session",
					code: "session-invalid",
					remediation: "run rook login",
				});
	} finally {
		if (!promoted) await context.transaction.rollback().catch(() => {});
	}
}

// Restore the headless session and hand back its agent. A write path first
// proves the collection is writable, naming the missing scope if not. Every
// path then promotes so a token refresh performed during restore is durably
// persisted (as login and doctor do); rolling a successful restore back would
// discard a rotated refresh token. Promotion touches only the OAuth session,
// never a profile record, so a show stays read-only against the PDS.
async function resolveContext(options, dependencies, { write }) {
	let identityPath;
	try {
		identityPath = resolveIdentityPath(options, dependencies.env, dependencies.cwd);
	} catch {
		throw new RookError("selected identity path is invalid", {
			stage: "gate",
			code: "identity-invalid",
			remediation: "run rook enroll --invite <url> --handle <name>",
		});
	}
	let identity;
	try {
		identity = await (dependencies.readIdentity ?? readIdentity)(identityPath);
	} catch (cause) {
		throw new RookError("selected identity is invalid", {
			stage: "gate",
			code: "identity-invalid",
			remediation: "run rook enroll --invite <url> --handle <name>",
			cause,
		});
	}
	if (!identity) {
		throw new RookError("no enrolled identity is available", {
			stage: "gate",
			code: "identity-invalid",
			remediation: "run rook enroll --invite <url> --handle <name>",
		});
	}

	const context = await (dependencies.restoreContext ?? restoreContext)(
		identity,
		identityPath,
		dependencies,
	);
	if (context.agent?.did !== identity.did) {
		await context.transaction.rollback().catch(() => {});
		throw new RookError("restored agent does not match the selected identity", {
			stage: "session",
			code: "session-identity-mismatch",
			remediation: "run rook login",
		});
	}

	if (write && !canWriteCollection(context.info?.scope, PROFILE_COLLECTION)) {
		await context.transaction.rollback().catch(() => {});
		throw scopeError(PROFILE_COLLECTION);
	}
	await promote(context);
	return { identity, context };
}

export async function profileShow(options, dependencies = {}) {
	const { identity, context } = await resolveContext(options, dependencies, { write: false });
	const existing = await readProfile(context.agent, identity.did, dependencies);
	if (!existing) return { published: false, did: identity.did };
	return {
		published: true,
		did: identity.did,
		uri: existing.uri,
		cid: existing.cid,
		profile: existing.value,
	};
}

export async function profilePublish(options, dependencies = {}) {
	if (options.avatar && options.removeAvatar) {
		throw new RookError("pass either --avatar or --remove-avatar, not both", {
			stage: "gate",
			code: "profile-invalid",
		});
	}
	const { identity, context } = await resolveContext(options, dependencies, { write: true });
	const repo = identity.did;
	const fileData = options.file ? await readProfileFile(options.file, dependencies) : {};
	const inputs = {
		displayName: firstDefined(options.displayName, fileData.displayName),
		description: firstDefined(options.description, fileData.description),
		operator: firstDefined(options.operator, fileData.operator),
		links: firstDefined(options.links, fileData.links),
		tags: firstDefined(options.tags, fileData.tags),
	};

	const existing = await readProfile(context.agent, repo, dependencies);

	let avatar;
	if (options.removeAvatar) {
		avatar = undefined;
	} else if (options.avatar) {
		avatar = await uploadAvatar(context.agent, options.avatar, dependencies);
	} else if (existing?.value?.avatar !== undefined) {
		avatar = existing.value.avatar;
	}

	const record = buildProfileRecord(inputs, {
		existing: existing?.value,
		avatar,
		now: nowIso(dependencies),
	});

	if (existing && recordsEqual(record, existing.value)) {
		return {
			outcome: "unchanged",
			did: repo,
			uri: existing.uri,
			cid: existing.cid,
			profile: existing.value,
		};
	}

	const written = await putProfile(
		context.agent,
		repo,
		record,
		existing ? existing.cid : undefined,
		dependencies,
	);
	return {
		outcome: existing ? "updated" : "created",
		did: repo,
		uri: written.uri,
		cid: written.cid,
		profile: record,
	};
}

export async function profileRemove(options, dependencies = {}) {
	const { identity, context } = await resolveContext(options, dependencies, { write: true });
	const repo = identity.did;
	const existing = await readProfile(context.agent, repo, dependencies);
	if (!existing) return { outcome: "absent", did: repo };
	await deleteProfile(context.agent, repo, existing.cid, dependencies);
	return { outcome: "removed", did: repo, uri: existing.uri };
}

function showHuman(result) {
	if (!result.published) return "no profile published";
	const profile = result.profile;
	const lines = [`displayName: ${profile.displayName}`, `description: ${profile.description}`];
	if (profile.operator) lines.push(`operator: ${profile.operator}`);
	if (Array.isArray(profile.links) && profile.links.length > 0) {
		lines.push(`links: ${profile.links.join(", ")}`);
	}
	if (Array.isArray(profile.tags) && profile.tags.length > 0) {
		lines.push(`tags: ${profile.tags.join(", ")}`);
	}
	if (profile.avatar) lines.push("avatar: present");
	if (profile.createdAt) lines.push(`createdAt: ${profile.createdAt}`);
	lines.push(`uri: ${result.uri}`);
	return lines.join("\n");
}

function publishHuman(result) {
	return [`profile ${result.outcome}`, `uri: ${result.uri}`].join("\n");
}

function removeHuman(result) {
	return result.outcome === "removed" ? `profile removed ${result.uri}` : "no profile to remove";
}

export function register(program, dependencies = {}) {
	const profile = program
		.command("profile")
		.description("show, publish, or remove the rook's thermals profile record")
		.option("--json", "emit structured JSON")
		.action(async (localOptions, command) => {
			const output = createOutput({ ...dependencies, json: localOptions.json });
			try {
				const result = await profileShow(command.optsWithGlobals(), dependencies);
				output.success(result, showHuman(result));
			} catch (error) {
				output.failure(error);
				process.exitCode = 1;
			}
		});

	profile
		.command("publish")
		.description("create or update the profile record (rkey self) in the rook's own repo")
		.option("--display-name <name>", "display name (required)")
		.option("--description <text>", "description (required)")
		.option("--operator <text>", "operator disclosure: the human or org behind the rook")
		.option("--links <uri>", "profile link URI (repeatable or comma-separated)", collectList)
		.option("--tags <tag>", "profile tag (repeatable or comma-separated; max 8)", collectList)
		.option("--avatar <path>", "local image to upload as the avatar (png, jpg, gif, webp)")
		.option("--remove-avatar", "drop the existing avatar while keeping the record")
		.option("--file <path>", "JSON file of profile fields; explicit flags override file fields")
		.option("--json", "emit structured JSON")
		.action(async (localOptions, command) => {
			const output = createOutput({ ...dependencies, json: localOptions.json });
			try {
				const result = await profilePublish(
					{ ...command.optsWithGlobals(), ...localOptions },
					dependencies,
				);
				output.success(result, publishHuman(result));
			} catch (error) {
				output.failure(error);
				process.exitCode = 1;
			}
		});

	profile
		.command("remove")
		.description("delete the profile record, leaving the thermals leaderboard")
		.option("--json", "emit structured JSON")
		.action(async (localOptions, command) => {
			const output = createOutput({ ...dependencies, json: localOptions.json });
			try {
				const result = await profileRemove(
					{ ...command.optsWithGlobals(), ...localOptions },
					dependencies,
				);
				output.success(result, removeHuman(result));
			} catch (error) {
				output.failure(error);
				process.exitCode = 1;
			}
		});

	return profile;
}
