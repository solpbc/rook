// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { createHash, createPublicKey, createVerify } from "node:crypto";
import test from "node:test";
import {
	base64urlEncode,
	computeJwkThumbprint,
	createAccessToken,
	createDpopProof,
	pemToJwk,
	signTos,
} from "../src/lib/welcome-mat.js";
import { testKeys } from "./helpers.js";

function decode(part) {
	return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

test("welcome-mat JWT byte shapes and signatures are exact", async () => {
	const keys = await testKeys();
	const jwk = pemToJwk(keys.publicKey);
	assert.deepEqual(Object.keys(jwk), ["kty", "n", "e"]);
	const expectedThumbprint = base64urlEncode(
		createHash("sha256")
			.update(JSON.stringify({ e: jwk.e, kty: "RSA", n: jwk.n }))
			.digest(),
	);
	assert.equal(computeJwkThumbprint(jwk), expectedThumbprint);
	const token = createAccessToken(
		{
			tosText: "exact\ntext",
			serviceOrigin: "https://rook.invalid",
			publicJwk: jwk,
			privatePem: keys.privateKey,
		},
		{ clock: () => 1_700_000_000_000, uuid: () => "access-jti" },
	);
	const parts = token.split(".");
	assert.deepEqual(decode(parts[0]), { typ: "wm+jwt", alg: "RS256" });
	assert.deepEqual(Object.keys(decode(parts[1])), ["jti", "tos_hash", "aud", "cnf", "iat"]);
	const verifier = createVerify("RSA-SHA256").update(`${parts[0]}.${parts[1]}`).end();
	assert.equal(
		verifier.verify(createPublicKey(keys.publicKey), Buffer.from(parts[2], "base64url")),
		true,
	);
	const signup = createDpopProof(
		{
			method: "POST",
			htu: "https://rook.invalid/api/signup",
			publicJwk: jwk,
			privatePem: keys.privateKey,
		},
		{ clock: () => 1_700_000_000_000, uuid: () => "proof-jti" },
	);
	assert.equal(Object.hasOwn(decode(signup.split(".")[1]), "ath"), false);
	const consent = createDpopProof(
		{
			method: "GET",
			htu: "https://rook.invalid/oauth/authorize",
			publicJwk: jwk,
			privatePem: keys.privateKey,
			accessToken: token,
		},
		{ clock: () => 1_700_000_000_000, uuid: () => "proof-jti-2" },
	);
	assert.deepEqual(Object.keys(decode(consent.split(".")[1])), ["jti", "htm", "htu", "iat", "ath"]);
	const tosSignature = signTos("exact\ntext", keys.privateKey);
	const tosVerifier = createVerify("RSA-SHA256").update("exact\ntext", "utf8").end();
	assert.equal(tosVerifier.verify(keys.publicKey, Buffer.from(tosSignature, "base64url")), true);
});
