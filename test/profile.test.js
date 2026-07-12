// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";
import { profilePublish, profileRemove, profileShow } from "../src/cmd/profile.js";
import {
	buildProfileRecord,
	canWriteCollection,
	expectedProfileUri,
	normalizeList,
	recordsEqual,
} from "../src/lib/profile.js";

const ROOK_DID = "did:plc:testrook";
const COLLECTION = "cloud.thermals.actor.profile";
const RKEY = "self";
const URI = expectedProfileUri(ROOK_DID);
const WRITE_SCOPE = "atproto transition:generic blob:*/*";
const CLOCK = () => Date.parse("2026-07-12T00:00:00.000Z");

// An in-memory PDS repo holding at most the single self record, mirroring the
// getRecord/putRecord/deleteRecord/uploadBlob semantics the command relies on.
function profileAgent({ record = null, did = ROOK_DID } = {}) {
	const store = { record, counter: 0 };
	const calls = { puts: [], deletes: [], uploads: [] };
	const agent = {
		did,
		com: {
			atproto: {
				repo: {
					getRecord: async ({ repo, collection, rkey }) => {
						assert.equal(collection, COLLECTION);
						assert.equal(rkey, RKEY);
						if (!store.record) {
							// Mirror the live PDS RecordNotFoundError: HTTP 404, error code
							// "RecordNotFound" (not the 400 some other mocks assume).
							throw Object.assign(new Error("Record not found"), {
								status: 404,
								error: "RecordNotFound",
							});
						}
						return {
							data: {
								uri: `at://${repo}/${collection}/${rkey}`,
								cid: store.record.cid,
								value: store.record.value,
							},
						};
					},
					putRecord: async ({ repo, collection, rkey, record: value, swapRecord }) => {
						assert.equal(collection, COLLECTION);
						assert.equal(rkey, RKEY);
						if (swapRecord !== undefined && (!store.record || store.record.cid !== swapRecord)) {
							throw Object.assign(new Error("InvalidSwap"), { status: 400, error: "InvalidSwap" });
						}
						store.counter += 1;
						const cid = `bafprofile${store.counter}0`;
						store.record = { cid, value };
						calls.puts.push({ repo, value, swapRecord });
						return { data: { uri: `at://${repo}/${collection}/${rkey}`, cid } };
					},
					deleteRecord: async ({ collection, rkey, swapRecord }) => {
						assert.equal(collection, COLLECTION);
						assert.equal(rkey, RKEY);
						if (swapRecord !== undefined && (!store.record || store.record.cid !== swapRecord)) {
							throw Object.assign(new Error("InvalidSwap"), { status: 400, error: "InvalidSwap" });
						}
						store.record = null;
						calls.deletes.push({ swapRecord });
						return {};
					},
					uploadBlob: async (bytes, { encoding }) => {
						calls.uploads.push({ size: bytes.length, encoding });
						return {
							data: {
								blob: {
									$type: "blob",
									ref: { $link: `bafblob${calls.uploads.length}` },
									mimeType: encoding,
									size: bytes.length,
								},
							},
						};
					},
				},
			},
		},
	};
	return { agent, store, calls };
}

function setup({ record = null, scope = WRITE_SCOPE, agentDid = ROOK_DID } = {}) {
	const { agent, store, calls } = profileAgent({ record, did: agentDid });
	const session = { promotes: 0, rollbacks: 0 };
	const dependencies = {
		env: { ROOK_IDENTITY_FILE: "/tmp/rook-profile-test/identity.json" },
		clock: CLOCK,
		readIdentity: async () => ({
			did: ROOK_DID,
			handle: "test.rook.invalid",
			serviceOrigin: "https://rook.invalid",
		}),
		restoreContext: async () => ({
			identity: { did: ROOK_DID },
			info: { scope },
			agent,
			transaction: {
				promote: async () => {
					session.promotes += 1;
				},
				rollback: async () => {
					session.rollbacks += 1;
				},
			},
		}),
	};
	return { agent, store, calls, session, dependencies };
}

// --- unit: pure helpers ----------------------------------------------------

test("canWriteCollection honors transitional, wildcard, and exact grants", () => {
	assert.equal(canWriteCollection("atproto transition:generic", COLLECTION), true);
	assert.equal(canWriteCollection("atproto repo:*", COLLECTION), true);
	assert.equal(canWriteCollection(`atproto repo:${COLLECTION}`, COLLECTION), true);
	assert.equal(canWriteCollection(`atproto repo:${COLLECTION}?action=create`, COLLECTION), true);
	assert.equal(canWriteCollection("atproto repo:sh.tangled.repo", COLLECTION), false);
	assert.equal(canWriteCollection("atproto", COLLECTION), false);
	assert.equal(canWriteCollection(undefined, COLLECTION), false);
});

test("normalizeList trims, drops empties, and passes through undefined", () => {
	assert.deepEqual(normalizeList(["  a ", "", "b"]), ["a", "b"]);
	assert.equal(normalizeList(undefined), undefined);
	assert.deepEqual(normalizeList([]), []);
});

test("buildProfileRecord requires displayName and description", () => {
	assert.throws(
		() => buildProfileRecord({ description: "x" }, { now: "t" }),
		(error) => error.code === "profile-invalid",
	);
	assert.throws(
		() => buildProfileRecord({ displayName: "x" }, { now: "t" }),
		(error) => error.code === "profile-invalid",
	);
});

test("buildProfileRecord caps tags at eight and validates link URIs", () => {
	assert.throws(
		() =>
			buildProfileRecord(
				{ displayName: "d", description: "x", tags: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] },
				{ now: "t" },
			),
		(error) => error.code === "profile-too-many-tags",
	);
	assert.throws(
		() =>
			buildProfileRecord(
				{ displayName: "d", description: "x", links: ["not a uri"] },
				{ now: "t" },
			),
		(error) => error.code === "profile-invalid-link",
	);
});

test("buildProfileRecord preserves createdAt and attaches the avatar blob", () => {
	const avatar = { $type: "blob", ref: { $link: "bafblob1" }, mimeType: "image/png", size: 10 };
	const record = buildProfileRecord(
		{ displayName: "Extro", description: "ships caps", tags: ["a", "b"], links: ["https://x.dev"] },
		{
			existing: { createdAt: "2026-01-01T00:00:00.000Z" },
			avatar,
			now: "2026-07-12T00:00:00.000Z",
		},
	);
	assert.equal(record.$type, COLLECTION);
	assert.equal(record.createdAt, "2026-01-01T00:00:00.000Z");
	assert.deepEqual(record.avatar, avatar);
	assert.deepEqual(record.tags, ["a", "b"]);
	assert.deepEqual(record.links, ["https://x.dev"]);
});

test("recordsEqual is order-insensitive across nested keys", () => {
	assert.equal(recordsEqual({ a: 1, b: [{ x: 1, y: 2 }] }, { b: [{ y: 2, x: 1 }], a: 1 }), true);
	assert.equal(recordsEqual({ a: 1 }, { a: 2 }), false);
});

// --- show ------------------------------------------------------------------

test("profile show reports absence as a state, not an error", async () => {
	const { dependencies, session, calls } = setup();
	const result = await profileShow({}, dependencies);
	assert.equal(result.published, false);
	// A read persists any token refresh (like doctor) but never writes a record.
	assert.equal(session.promotes, 1);
	assert.equal(session.rollbacks, 0);
	assert.equal(calls.puts.length, 0);
	assert.equal(calls.deletes.length, 0);
});

test("profile show returns the published record", async () => {
	const value = {
		$type: COLLECTION,
		displayName: "Extro",
		description: "ships caps",
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	const { dependencies } = setup({ record: { cid: "bafcur00", value } });
	const result = await profileShow({}, dependencies);
	assert.equal(result.published, true);
	assert.equal(result.uri, URI);
	assert.deepEqual(result.profile, value);
});

// --- publish ---------------------------------------------------------------

test("profile publish creates the self record from flags", async () => {
	const { dependencies, calls, store, session } = setup();
	const result = await profilePublish(
		{ displayName: "Extro", description: "ships caps", tags: ["agent", "atproto"] },
		dependencies,
	);
	assert.equal(result.outcome, "created");
	assert.equal(result.uri, URI);
	assert.equal(session.promotes, 1);
	assert.equal(calls.puts.length, 1);
	assert.equal(calls.puts[0].swapRecord, undefined, "create writes without a swap guard");
	assert.equal(store.record.value.$type, COLLECTION);
	assert.equal(store.record.value.createdAt, "2026-07-12T00:00:00.000Z");
	assert.deepEqual(store.record.value.tags, ["agent", "atproto"]);
});

test("profile publish updates in place, preserving createdAt and avatar with a swap guard", async () => {
	const avatar = { $type: "blob", ref: { $link: "bafkept" }, mimeType: "image/png", size: 5 };
	const value = {
		$type: COLLECTION,
		displayName: "Old",
		description: "old desc",
		avatar,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	const { dependencies, calls, store } = setup({ record: { cid: "bafcur00", value } });
	const result = await profilePublish(
		{ displayName: "New", description: "new desc" },
		dependencies,
	);
	assert.equal(result.outcome, "updated");
	assert.equal(calls.puts[0].swapRecord, "bafcur00", "update guards on the read cid");
	assert.equal(store.record.value.displayName, "New");
	assert.equal(store.record.value.createdAt, "2026-01-01T00:00:00.000Z");
	assert.deepEqual(store.record.value.avatar, avatar, "avatar survives an update that omits it");
});

test("profile publish is idempotent: an unchanged re-run adopts without writing", async () => {
	const { dependencies, calls, store } = setup();
	await profilePublish({ displayName: "Extro", description: "ships caps" }, dependencies);
	assert.equal(calls.puts.length, 1);
	// A second identical publish sees the stored record and converges without a write.
	const again = await profilePublish(
		{ displayName: "Extro", description: "ships caps" },
		dependencies,
	);
	assert.equal(again.outcome, "unchanged");
	assert.equal(calls.puts.length, 1, "no redundant second write");
	assert.equal(store.counter, 1, "still exactly one record");
});

test("profile publish uploads a local avatar and stores its blob ref", async () => {
	const { dependencies, calls, store } = setup();
	dependencies.readFile = async () => Buffer.from("PNGDATA");
	const result = await profilePublish(
		{ displayName: "Extro", description: "ships caps", avatar: "/tmp/pic.png" },
		dependencies,
	);
	assert.equal(result.outcome, "created");
	assert.equal(calls.uploads.length, 1);
	assert.equal(calls.uploads[0].encoding, "image/png");
	assert.equal(store.record.value.avatar.$type, "blob");
});

test("profile publish --remove-avatar drops the avatar but keeps the record", async () => {
	const avatar = { $type: "blob", ref: { $link: "bafkept" }, mimeType: "image/png", size: 5 };
	const value = {
		$type: COLLECTION,
		displayName: "Extro",
		description: "ships caps",
		avatar,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	const { dependencies, store } = setup({ record: { cid: "bafcur00", value } });
	const result = await profilePublish(
		{ displayName: "Extro", description: "ships caps", removeAvatar: true },
		dependencies,
	);
	assert.equal(result.outcome, "updated");
	assert.equal(store.record.value.avatar, undefined);
});

test("profile publish rejects both --avatar and --remove-avatar", async () => {
	const { dependencies, session } = setup();
	await assert.rejects(
		profilePublish(
			{ displayName: "x", description: "y", avatar: "/tmp/a.png", removeAvatar: true },
			dependencies,
		),
		(error) => error.code === "profile-invalid",
	);
	assert.equal(session.promotes, 0, "conflicting flags fail before touching the session");
});

test("profile publish merges --file fields with flags overriding", async () => {
	const { dependencies, store } = setup();
	dependencies.readFile = async () =>
		JSON.stringify({
			displayName: "From File",
			description: "file desc",
			tags: ["file-tag"],
			links: ["https://file.example"],
		});
	const result = await profilePublish(
		{ description: "flag desc", file: "/tmp/profile.json" },
		dependencies,
	);
	assert.equal(result.outcome, "created");
	assert.equal(store.record.value.displayName, "From File", "file supplies unset fields");
	assert.equal(store.record.value.description, "flag desc", "flag overrides the file field");
	assert.deepEqual(store.record.value.tags, ["file-tag"]);
	assert.deepEqual(store.record.value.links, ["https://file.example"]);
});

test("profile publish validates required fields after merging file and flags", async () => {
	const { dependencies, calls } = setup();
	await assert.rejects(
		profilePublish({ displayName: "only-name" }, dependencies),
		(error) => error.code === "profile-invalid",
	);
	assert.equal(calls.puts.length, 0);
});

test("profile publish fails with an actionable scope error naming the collection", async () => {
	const { dependencies, calls, session } = setup({ scope: "atproto" });
	await assert.rejects(
		profilePublish({ displayName: "Extro", description: "ships caps" }, dependencies),
		(error) =>
			error.code === "profile-scope-insufficient" &&
			error.remediation.includes(`repo:${COLLECTION}`),
	);
	assert.equal(calls.puts.length, 0, "no write is attempted without the scope");
	assert.equal(session.promotes, 0, "the session is never promoted");
	assert.equal(session.rollbacks, 1);
});

test("profile publish maps a live PDS scope rejection to the actionable error", async () => {
	const { dependencies } = setup();
	dependencies.restoreContext = async () => {
		const base = await setup({ scope: WRITE_SCOPE }).dependencies.restoreContext();
		base.agent.com.atproto.repo.putRecord = async () => {
			throw Object.assign(new Error("insufficient scope"), { status: 403, error: "InvalidToken" });
		};
		return base;
	};
	await assert.rejects(
		profilePublish({ displayName: "Extro", description: "ships caps" }, dependencies),
		(error) => error.code === "profile-scope-insufficient",
	);
});

// --- remove ----------------------------------------------------------------

test("profile remove deletes the record with a swap guard", async () => {
	const value = { $type: COLLECTION, displayName: "Extro", description: "ships caps" };
	const { dependencies, calls, store } = setup({ record: { cid: "bafcur00", value } });
	const result = await profileRemove({}, dependencies);
	assert.equal(result.outcome, "removed");
	assert.equal(result.uri, URI);
	assert.equal(calls.deletes[0].swapRecord, "bafcur00");
	assert.equal(store.record, null);
});

test("profile remove reports absence without deleting or a stack trace", async () => {
	const { dependencies, calls } = setup();
	const result = await profileRemove({}, dependencies);
	assert.equal(result.outcome, "absent");
	assert.equal(calls.deletes.length, 0);
});

// --- round-trip ------------------------------------------------------------

test("publish then remove round-trips to an empty profile", async () => {
	const { dependencies, store } = setup();
	await profilePublish({ displayName: "Extro", description: "ships caps" }, dependencies);
	assert.notEqual(store.record, null);
	const removed = await profileRemove({}, dependencies);
	assert.equal(removed.outcome, "removed");
	const show = await profileShow({}, dependencies);
	assert.equal(show.published, false);
});

test("a restored agent that mismatches the identity fails closed", async () => {
	const { dependencies, session } = setup({ agentDid: "did:plc:someoneelse" });
	await assert.rejects(
		profileShow({}, dependencies),
		(error) => error.code === "session-identity-mismatch",
	);
	assert.equal(session.rollbacks, 1);
});
