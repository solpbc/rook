// SPDX-License-Identifier: AGPL-3.0-only

import { createPrivateKey } from "node:crypto";
import { RookError } from "./error-format.js";
import { atomicCreateFile, readJsonFile } from "./storage.js";

function requiredString(value, name) {
	if (typeof value !== "string" || value.length === 0)
		throw new RookError(`identity ${name} is invalid`);
	return value;
}

export function validateIdentity(value) {
	if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
		throw new RookError("identity file is malformed or unsupported");
	}
	const did = requiredString(value.did, "did");
	const handle = requiredString(value.handle, "handle");
	if (!/^did:plc:[a-z2-7]+$/.test(did)) throw new RookError("identity DID must be a did:plc DID");
	if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(handle) || !handle.includes(".")) {
		throw new RookError("identity handle is invalid");
	}
	const serviceOrigin = requiredString(value.serviceOrigin, "service origin");
	let parsedOrigin;
	try {
		parsedOrigin = new URL(serviceOrigin).origin;
	} catch {
		throw new RookError("identity service origin is invalid");
	}
	if (parsedOrigin !== serviceOrigin)
		throw new RookError("identity service origin must be an origin");
	const rsaPrivateKeyPem = requiredString(value.rsaPrivateKeyPem, "private key");
	const createdAt = requiredString(value.createdAt, "creation time");
	if (Number.isNaN(Date.parse(createdAt))) throw new RookError("identity creation time is invalid");
	let key;
	try {
		key = createPrivateKey(rsaPrivateKeyPem);
	} catch (cause) {
		throw new RookError("identity private key is invalid", { cause });
	}
	const details = key.asymmetricKeyDetails;
	if (key.asymmetricKeyType !== "rsa" || details?.modulusLength !== 4096) {
		throw new RookError("identity private key must be RSA-4096");
	}
	const actual = key.export({ format: "jwk" });
	const expected = value.rsaPublicJwk;
	if (
		!expected ||
		Object.keys(expected).sort().join(",") !== "e,kty,n" ||
		expected.kty !== "RSA" ||
		actual.kty !== expected.kty ||
		actual.n !== expected.n ||
		actual.e !== expected.e
	) {
		throw new RookError("identity private key does not match its public key");
	}
	const allowed = [
		"version",
		"did",
		"handle",
		"serviceOrigin",
		"rsaPrivateKeyPem",
		"rsaPublicJwk",
		"createdAt",
	].sort();
	if (Object.keys(value).sort().join(",") !== allowed.join(",")) {
		throw new RookError("identity file contains unsupported fields");
	}
	return {
		version: 1,
		did,
		handle,
		serviceOrigin,
		rsaPrivateKeyPem,
		rsaPublicJwk: expected,
		createdAt,
	};
}

export async function readIdentity(identityPath) {
	const value = await readJsonFile(identityPath);
	return value === undefined ? undefined : validateIdentity(value);
}

export async function writeIdentity(identityPath, identity) {
	const valid = validateIdentity(identity);
	await atomicCreateFile(identityPath, `${JSON.stringify(valid, null, 2)}\n`);
}

export function publicIdentity(identity, identityPath) {
	return {
		did: identity.did,
		handle: identity.handle,
		serviceOrigin: identity.serviceOrigin,
		identityPath,
	};
}
