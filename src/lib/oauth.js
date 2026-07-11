// SPDX-License-Identifier: AGPL-3.0-only

import { NodeOAuthClient, requestLocalLock } from "@atproto/oauth-client-node";
import { RookError } from "./error-format.js";

export function scopeSet(scope) {
	if (typeof scope !== "string") return new Set();
	return new Set(scope.trim().split(/\s+/).filter(Boolean));
}

export function missingScopes(servedScope, grantedScope) {
	const granted = scopeSet(grantedScope);
	return [...scopeSet(servedScope)].filter((token) => !granted.has(token));
}

export function rpcScopes(scope) {
	return [...scopeSet(scope)].flatMap((token) => {
		if (!token.startsWith("rpc:")) return [];
		const question = token.indexOf("?");
		const nsid = token.slice(4, question < 0 ? undefined : question);
		const params = new URLSearchParams(question < 0 ? "" : token.slice(question + 1));
		const aud = params.get("aud");
		return aud ? [{ token, nsid, aud }] : [];
	});
}

export async function fetchClientMetadata(serviceOrigin, options = {}) {
	const clientId = new URL("/client-metadata.json", serviceOrigin).toString();
	const Client = options.NodeOAuthClient ?? NodeOAuthClient;
	let metadata;
	try {
		metadata = await Client.fetchMetadata({ clientId, fetch: options.fetch ?? globalThis.fetch });
	} catch {
		throw new RookError("could not fetch valid OAuth client metadata");
	}
	if (
		metadata.client_id !== clientId ||
		typeof metadata.scope !== "string" ||
		scopeSet(metadata.scope).size === 0
	) {
		throw new RookError("OAuth client metadata is missing its authoritative scope");
	}
	return metadata;
}

export function createOAuthClient(metadata, stores, options = {}) {
	const Client = options.NodeOAuthClient ?? NodeOAuthClient;
	return new Client({
		clientMetadata: metadata,
		stateStore: stores.stateStore,
		sessionStore: stores.sessionStore,
		fetch: options.fetch ?? globalThis.fetch,
		requestLock: options.requestLock ?? requestLocalLock,
	});
}

export function tokenInfoFields(info) {
	const expiresAt = info.expiresAt
		? info.expiresAt instanceof Date
			? info.expiresAt.toISOString()
			: new Date(info.expiresAt).toISOString()
		: null;
	return { scope: info.scope, expiresAt, expired: info.expired === true, sub: info.sub };
}
