// SPDX-License-Identifier: AGPL-3.0-only

// Proves the installed `vit/cap.js` dependency resolves and is invocable from a
// clean install with no repo-relative source path. Runs inside the packaging
// container against the installed tree; see scripts/pack-check.mjs.

import { publishCap } from "vit/cap.js";

const repo = "did:plc:probe";
const agent = {
	did: repo,
	com: {
		atproto: {
			repo: {
				putRecord: async ({ repo: target, collection, rkey }) => ({
					data: { uri: `at://${target}/${collection}/${rkey}`, cid: "bafprobecid" },
				}),
			},
		},
	},
};

const result = await publishCap(agent, {
	repo,
	title: "probe",
	description: "probe",
	text: "",
	ref: "rook-probe-check",
	createdAt: "2026-01-01T00:00:00.000Z",
	beacon: "vit:example.com//probe",
	embed: { external: { uri: "https://tangled.org/x/y/pulls/1", title: "t", description: "d" } },
	rkey: "probe1",
});

if (
	result.uri !== "at://did:plc:probe/org.v-it.cap/probe1" ||
	result.rkey !== "probe1" ||
	result.ref !== "rook-probe-check"
) {
	console.error(`__VIT_CAP_PROBE_FAIL__ ${JSON.stringify(result)}`);
	process.exit(1);
}
console.log(`__VIT_CAP_OK__ ${result.ref}`);
