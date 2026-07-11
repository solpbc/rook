// SPDX-License-Identifier: AGPL-3.0-only

import {
	createHash,
	createPublicKey,
	createSign,
	generateKeyPair as generateKeyPairCallback,
	randomUUID,
} from "node:crypto";
import { promisify } from "node:util";

const generateKeyPair = promisify(generateKeyPairCallback);

export function base64urlEncode(value) {
	return Buffer.from(value).toString("base64url");
}

export async function generateRsa4096(options = {}) {
	const generator = options.generateKeyPair ?? generateKeyPair;
	return generator("rsa", {
		modulusLength: 4096,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
}

export function pemToJwk(publicPem) {
	const jwk = createPublicKey(publicPem).export({ format: "jwk" });
	return { kty: jwk.kty, n: jwk.n, e: jwk.e };
}

export function computeJwkThumbprint(jwk) {
	const canonical = JSON.stringify({ e: jwk.e, kty: "RSA", n: jwk.n });
	return base64urlEncode(createHash("sha256").update(canonical, "utf8").digest());
}

export function signTos(text, privatePem) {
	return signBytes(Buffer.from(text, "utf8"), privatePem);
}

function signBytes(bytes, privatePem) {
	const signer = createSign("RSA-SHA256");
	signer.update(bytes);
	signer.end();
	return base64urlEncode(signer.sign(privatePem));
}

function jwt(header, payload, privatePem) {
	const encodedHeader = base64urlEncode(JSON.stringify(header));
	const encodedPayload = base64urlEncode(JSON.stringify(payload));
	const signingInput = `${encodedHeader}.${encodedPayload}`;
	return `${signingInput}.${signBytes(Buffer.from(signingInput, "ascii"), privatePem)}`;
}

function nowSeconds(clock) {
	const value = clock();
	return Math.floor((value instanceof Date ? value.getTime() : value) / 1000);
}

export function createAccessToken({ tosText, serviceOrigin, publicJwk, privatePem }, options = {}) {
	const clock = options.clock ?? (() => Date.now());
	const uuid = options.uuid ?? randomUUID;
	const header = { typ: "wm+jwt", alg: "RS256" };
	const payload = {
		jti: uuid(),
		tos_hash: base64urlEncode(createHash("sha256").update(tosText, "utf8").digest()),
		aud: serviceOrigin,
		cnf: { jkt: computeJwkThumbprint(publicJwk) },
		iat: nowSeconds(clock),
	};
	return jwt(header, payload, privatePem);
}

export function createDpopProof({ method, htu, publicJwk, privatePem, accessToken }, options = {}) {
	const clock = options.clock ?? (() => Date.now());
	const uuid = options.uuid ?? randomUUID;
	const header = { typ: "dpop+jwt", alg: "RS256", jwk: publicJwk };
	const payload = {
		jti: uuid(),
		htm: method.toUpperCase(),
		htu,
		iat: nowSeconds(clock),
	};
	if (accessToken !== undefined) {
		payload.ath = base64urlEncode(createHash("sha256").update(accessToken, "utf8").digest());
	}
	return jwt(header, payload, privatePem);
}

export function dpopHtu(input) {
	const url = new URL(input);
	return `${url.origin}${url.pathname}`;
}
