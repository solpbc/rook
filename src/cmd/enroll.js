// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from "node:crypto";
import { fetchTos, fetchWelcome } from "../lib/discovery.js";
import { RookError } from "../lib/error-format.js";
import { publicIdentity, readIdentity, writeIdentity } from "../lib/identity.js";
import { createOutput } from "../lib/json-output.js";
import { resolveIdentityPath } from "../lib/paths.js";
import {
	createAccessToken,
	createDpopProof,
	dpopHtu,
	generateRsa4096,
	pemToJwk,
	signTos,
} from "../lib/welcome-mat.js";

const PRE_CONSUMPTION_ERRORS = new Set([
	"InvalidRequest",
	"AuthRequired",
	"AuthFailed",
	"InvalidSignature",
	"InvalidToken",
	"InviteRequired",
	"InviteInvalid",
	"InvalidHandle",
	"HandleReserved",
	"HandleTaken",
]);

function validateOptions(invite, handle) {
	if (!invite) throw new RookError("--invite is required");
	if (!handle) throw new RookError("--handle is required");
	if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(handle) || handle.includes(".")) {
		throw new RookError("handle must be a single name without dots");
	}
	let url;
	try {
		url = new URL(invite);
	} catch {
		throw new RookError("invite must be a valid HTTPS URL");
	}
	if (url.protocol !== "https:" || !url.hash)
		throw new RookError("invite must be an HTTPS URL with a fragment");
	return { inviteUrl: url, handle: handle.toLowerCase() };
}

function responseError(status, body) {
	if (status === 403 && body?.error === "InviteInvalid") {
		return new RookError(
			"The invite is invalid or already spent; the service does not distinguish which. This attempt did not consume it.",
		);
	}
	if (PRE_CONSUMPTION_ERRORS.has(body?.error)) {
		const reason = typeof body.message === "string" ? body.message : body.error;
		return new RookError(
			`Enrollment was rejected before this attempt consumed an invite: ${reason}.`,
		);
	}
	return new RookError(
		"Enrollment outcome is undetermined; the invite may have been consumed. Do not retry with a new invite.",
	);
}

export async function enroll(options, dependencies = {}) {
	const fetchImpl = dependencies.fetch ?? globalThis.fetch;
	const clock = dependencies.clock ?? (() => Date.now());
	const uuid = dependencies.uuid ?? randomUUID;
	const { inviteUrl, handle } = validateOptions(options.invite, options.handle);
	const identityPath = resolveIdentityPath(options, dependencies.env, dependencies.cwd);
	let existing;
	try {
		existing = await (dependencies.readIdentity ?? readIdentity)(identityPath);
	} catch (cause) {
		throw new RookError("selected identity file is malformed; refusing to overwrite it", { cause });
	}
	if (existing) return { ...publicIdentity(existing, identityPath), existing: true };

	const serviceOrigin = inviteUrl.origin;
	await fetchWelcome(serviceOrigin, fetchImpl);
	const tosText = await fetchTos(serviceOrigin, fetchImpl);
	const { publicKey, privateKey } = await (dependencies.generateRsa4096 ?? generateRsa4096)();
	const publicJwk = pemToJwk(publicKey);
	const cryptoOptions = { clock, uuid };
	const accessToken = createAccessToken(
		{ tosText, serviceOrigin, publicJwk, privatePem: privateKey },
		cryptoOptions,
	);
	const endpoint = new URL("/api/signup", serviceOrigin);
	const proof = createDpopProof(
		{ method: "POST", htu: dpopHtu(endpoint), publicJwk, privatePem: privateKey },
		cryptoOptions,
	);
	let response;
	try {
		response = await fetchImpl(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json", DPoP: proof },
			body: JSON.stringify({
				handle,
				tos_signature: signTos(tosText, privateKey),
				access_token: accessToken,
				ref: options.invite,
			}),
		});
	} catch {
		throw responseError(0, undefined);
	}
	let body;
	try {
		body = await response.json();
	} catch {
		throw responseError(response.status, undefined);
	}
	if (response.status !== 200) throw responseError(response.status, body);
	if (
		typeof body.did !== "string" ||
		typeof body.handle !== "string" ||
		body.access_token !== accessToken ||
		body.token_type !== "DPoP"
	) {
		throw responseError(response.status, undefined);
	}
	const identity = {
		version: 1,
		did: body.did,
		handle: body.handle,
		serviceOrigin,
		rsaPrivateKeyPem: privateKey,
		rsaPublicJwk: publicJwk,
		createdAt: new Date(clock()).toISOString(),
	};
	try {
		await (dependencies.writeIdentity ?? writeIdentity)(identityPath, identity);
	} catch (cause) {
		throw new RookError(
			`Enrollment succeeded remotely, but rook could not save the local identity at ${identityPath}. The invite was consumed and the remote account may be unrecoverable because its private key was not persisted. Do not retry with a new invite.`,
			{ cause },
		);
	}
	return { ...publicIdentity(identity, identityPath), existing: false };
}

export function register(program, dependencies = {}) {
	program
		.command("enroll")
		.description("enroll a new rook identity")
		.option("--invite <url>", "single-use enrollment invite")
		.option("--handle <name>", "single dotless handle name")
		.option("--json", "emit structured JSON")
		.action(async (localOptions, command) => {
			const options = command.optsWithGlobals();
			const output = createOutput({ ...dependencies, json: localOptions.json });
			try {
				const result = await enroll({ ...options, ...localOptions }, dependencies);
				output.success(
					result,
					result.existing
						? `${result.handle} (${result.did}) is already enrolled.`
						: "Enrollment succeeded; the invite was consumed.",
				);
			} catch (error) {
				output.failure(error);
				process.exitCode = 1;
			}
		});
}
