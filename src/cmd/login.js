// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from "node:crypto";
import { fetchTos } from "../lib/discovery.js";
import { RookError } from "../lib/error-format.js";
import { readIdentity } from "../lib/identity.js";
import { createOutput } from "../lib/json-output.js";
import {
	createOAuthClient,
	fetchClientMetadata,
	missingScopes,
	tokenInfoFields,
} from "../lib/oauth.js";
import { deriveIdentityPaths, resolveIdentityPath } from "../lib/paths.js";
import { LoginStorageTransaction } from "../lib/storage.js";
import { createAccessToken, createDpopProof, dpopHtu } from "../lib/welcome-mat.js";

function validateSession(session, info, identity) {
	if (session.did !== identity.did || info.sub !== identity.did) {
		throw new RookError("OAuth session subject does not match the selected identity");
	}
	if (info.expired === true) throw new RookError("OAuth session is expired");
}

function validatePreview(preview, metadata, identity) {
	const request = preview?.consent_request;
	if (!request || request.client_id !== metadata.client_id) {
		throw new RookError("authorization preview does not match this OAuth client");
	}
	if (
		missingScopes(metadata.scope, request.scope).length > 0 ||
		missingScopes(request.scope, metadata.scope).length > 0
	) {
		throw new RookError("authorization preview scope does not match served client metadata");
	}
	if (!metadata.redirect_uris?.includes(request.redirect_uri)) {
		throw new RookError("authorization preview uses an unregistered redirect URI");
	}
	if (
		request.login_hint !== null &&
		request.login_hint !== undefined &&
		request.login_hint !== identity.did &&
		request.login_hint !== identity.handle
	) {
		throw new RookError("authorization preview targets a different identity");
	}
}

async function beginTransaction(paths, dependencies) {
	const Transaction = dependencies.LoginStorageTransaction ?? LoginStorageTransaction;
	return new Transaction(paths.sessionPath, paths.statePath, {
		clock: dependencies.clock,
		fs: dependencies.fs,
	}).start();
}

function makeClient(metadata, transaction, dependencies) {
	if (dependencies.oauthClientFactory) {
		return dependencies.oauthClientFactory(metadata, transaction.stores);
	}
	return createOAuthClient(metadata, transaction.stores, dependencies);
}

async function restore(identity, metadata, paths, dependencies) {
	const transaction = await beginTransaction(paths, dependencies);
	try {
		const client = makeClient(metadata, transaction, dependencies);
		const session = await client.restore(identity.did);
		const info = await session.getTokenInfo(false);
		validateSession(session, info, identity);
		return { transaction, session, info };
	} catch (error) {
		await transaction.rollback();
		return { error };
	}
}

async function freshLogin(identity, metadata, paths, dependencies) {
	const fetchImpl = dependencies.fetch ?? globalThis.fetch;
	const clock = dependencies.clock ?? (() => Date.now());
	const uuid = dependencies.uuid ?? randomUUID;
	const transaction = await beginTransaction(paths, dependencies);
	try {
		const client = makeClient(metadata, transaction, dependencies);
		await transaction.stores.stateStore.clear();
		const authorization = await client.authorize(identity.did, { scope: metadata.scope });
		const authorizationUrl = new URL(authorization);
		let previewResponse;
		try {
			previewResponse = await fetchImpl(authorizationUrl);
		} catch {
			throw new RookError("could not fetch authorization consent preview");
		}
		if (previewResponse.status !== 200) {
			throw new RookError(`authorization consent preview returned HTTP ${previewResponse.status}`);
		}
		let preview;
		try {
			preview = await previewResponse.json();
		} catch {
			throw new RookError("authorization consent preview returned malformed JSON");
		}
		validatePreview(preview, metadata, identity);
		const tosText = await fetchTos(identity.serviceOrigin, fetchImpl);
		const wmJwt = createAccessToken(
			{
				tosText,
				serviceOrigin: identity.serviceOrigin,
				publicJwk: identity.rsaPublicJwk,
				privatePem: identity.rsaPrivateKeyPem,
			},
			{ clock, uuid },
		);
		const dpop = createDpopProof(
			{
				method: "GET",
				htu: dpopHtu(authorizationUrl),
				publicJwk: identity.rsaPublicJwk,
				privatePem: identity.rsaPrivateKeyPem,
				accessToken: wmJwt,
			},
			{ clock, uuid },
		);
		let consentResponse;
		try {
			consentResponse = await fetchImpl(authorizationUrl, {
				redirect: "manual",
				headers: { Authorization: `DPoP ${wmJwt}`, DPoP: dpop },
			});
		} catch {
			throw new RookError("authorization consent request failed");
		}
		if (consentResponse.status !== 302) {
			throw new RookError(`authorization consent returned HTTP ${consentResponse.status}`);
		}
		const location = consentResponse.headers.get("location");
		if (!location) throw new RookError("authorization consent response is missing its redirect");
		let params;
		try {
			params = new URL(location).searchParams;
		} catch {
			throw new RookError("authorization consent response has an invalid redirect");
		}
		let session;
		try {
			({ session } = await client.callback(params));
		} catch {
			if (params.get("error") === "access_denied") throw new RookError("Authorization was denied.");
			throw new RookError("OAuth callback failed");
		}
		if (!session) throw new RookError("OAuth callback did not return a session");
		const info = await session.getTokenInfo(false);
		validateSession(session, info, identity);
		if (!(await transaction.stores.sessionStore.get(identity.did))) {
			throw new RookError("OAuth callback did not durably save the new session");
		}
		const missing = missingScopes(metadata.scope, info.scope);
		if (missing.length > 0) {
			throw new RookError(`OAuth grant is missing required scopes: ${missing.join(" ")}`);
		}
		await transaction.promote();
		return { session, info };
	} catch (error) {
		await transaction.rollback();
		throw error;
	}
}

export async function login(options, dependencies = {}) {
	const identityPath = resolveIdentityPath(options, dependencies.env, dependencies.cwd);
	let identity;
	try {
		identity = await (dependencies.readIdentity ?? readIdentity)(identityPath);
	} catch (cause) {
		throw new RookError("selected identity is malformed; repair it before logging in", { cause });
	}
	if (!identity) {
		throw new RookError("no identity is enrolled at the selected path", {
			hint: "run rook enroll --invite <url> --handle <name>",
		});
	}
	const metadata = await fetchClientMetadata(identity.serviceOrigin, dependencies);
	const paths = deriveIdentityPaths(identityPath);
	const restored = await restore(identity, metadata, paths, dependencies);
	if (restored.session) {
		const missing = missingScopes(metadata.scope, restored.info.scope);
		if (missing.length === 0) {
			await restored.transaction.promote();
			return {
				did: identity.did,
				handle: identity.handle,
				serviceOrigin: identity.serviceOrigin,
				scope: restored.info.scope,
				expiresAt: tokenInfoFields(restored.info).expiresAt,
				restored: true,
			};
		}
		await restored.transaction.rollback();
	}
	const fresh = await freshLogin(identity, metadata, paths, dependencies);
	return {
		did: identity.did,
		handle: identity.handle,
		serviceOrigin: identity.serviceOrigin,
		scope: fresh.info.scope,
		expiresAt: tokenInfoFields(fresh.info).expiresAt,
		restored: false,
	};
}

export function register(program, dependencies = {}) {
	program
		.command("login")
		.description("establish or refresh a headless OAuth session")
		.option("--json", "emit structured JSON")
		.action(async (localOptions, command) => {
			const output = createOutput({ ...dependencies, json: localOptions.json });
			try {
				const result = await login(command.optsWithGlobals(), dependencies);
				output.success(result, `${result.handle} is logged in.`);
			} catch (error) {
				output.failure(error);
				process.exitCode = 1;
			}
		});
}
