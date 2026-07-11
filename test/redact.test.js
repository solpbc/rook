// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";
import { createProgram } from "../src/cli.js";
import { redact } from "../src/lib/redact.js";
import { memoryStream, temporaryHome } from "./helpers.js";

const RAW = "RAW-PRIVATE-JWK-CANARY";
const ENCODED = Buffer.from(RAW).toString("base64url");
const MESSAGE = [
	"-----BEGIN PRIVATE KEY-----\nPEM-CANARY\n-----END PRIVATE KEY-----",
	"eyJjYW5hcnki.eyJzZWNyZXQi.c2lnbmF0dXJl",
	"rkat_ACCESS-CANARY",
	"Authorization: Bearer AUTH-CANARY",
	"DPoP: PROOF-CANARY",
	"https://rook.invalid/roost#INVITE-CANARY",
	"https://callback.invalid/?code=CODE-CANARY",
	`{"d":"${RAW}","token":"${ENCODED}"}`,
].join(" ");

test("redact scrubs every secret field class including encoded values", () => {
	const value = redact({
		rsaPrivateKeyPem: RAW,
		d: RAW,
		access_token: ENCODED,
		refresh_token: RAW,
		authorization: RAW,
		dpop: RAW,
		token: RAW,
		code: RAW,
		tos_signature: RAW,
		invite: RAW,
		ref: RAW,
		message: MESSAGE,
	});
	const serialized = JSON.stringify(value);
	for (const canary of [
		RAW,
		ENCODED,
		"PEM-CANARY",
		"AUTH-CANARY",
		"PROOF-CANARY",
		"INVITE-CANARY",
		"CODE-CANARY",
		"rkat_ACCESS-CANARY",
	]) {
		assert.doesNotMatch(serialized, new RegExp(canary));
	}
});

test("stdout and stderr remain secret-free across every command failure", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	for (const [command, args] of [
		["enroll", ["--invite", "https://rook.invalid/roost#INVITE-CANARY", "--handle", "rook"]],
		["login", []],
		["whoami", []],
		["doctor", []],
	]) {
		for (const json of [false, true]) {
			const stdout = memoryStream();
			const stderr = memoryStream();
			const program = createProgram({
				stdout,
				stderr,
				env: home.env,
				readIdentity: async () => {
					throw new Error(MESSAGE);
				},
			});
			process.exitCode = 0;
			await program.parseAsync(["node", "rook", command, ...args, ...(json ? ["--json"] : [])]);
			const combined = `${stdout}${stderr}`;
			for (const canary of [
				RAW,
				ENCODED,
				"PEM-CANARY",
				"AUTH-CANARY",
				"PROOF-CANARY",
				"INVITE-CANARY",
				"CODE-CANARY",
				"rkat_ACCESS-CANARY",
			]) {
				assert.doesNotMatch(combined, new RegExp(canary), `${command} leaked ${canary}`);
			}
		}
	}
	process.exitCode = 0;
});
