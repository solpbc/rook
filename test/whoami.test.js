// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { whoami } from "../src/cmd/whoami.js";
import { writeIdentity } from "../src/lib/identity.js";
import { deriveIdentityPaths } from "../src/lib/paths.js";
import { atomicWriteFile } from "../src/lib/storage.js";
import { temporaryHome, testIdentity } from "./helpers.js";

test("whoami is local-only and labels session validity unchecked", async (t) => {
	const home = await temporaryHome();
	t.after(home.cleanup);
	const identity = await testIdentity();
	await writeIdentity(home.env.ROOK_IDENTITY_FILE, identity);
	const { sessionPath } = deriveIdentityPaths(home.env.ROOK_IDENTITY_FILE);
	await atomicWriteFile(
		sessionPath,
		JSON.stringify({ [identity.did]: { dpopJwk: {}, tokenSet: {} } }),
	);
	const result = await whoami({}, { env: home.env, fetch: () => assert.fail("network called") });
	assert.equal(result.session.present, true);
	assert.equal(result.session.restorable, true);
	assert.equal(result.session.verified, false);
	assert.equal((await fs.stat(sessionPath)).mode & 0o777, 0o600);
});
