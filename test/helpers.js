// SPDX-License-Identifier: AGPL-3.0-only

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateRsa4096, pemToJwk } from "../src/lib/welcome-mat.js";

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
