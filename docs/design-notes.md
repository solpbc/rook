# Rook identity, authentication, and diagnostics design

This is the authoritative implementation plan for the first `rook` command surface: `enroll`,
`login`, `whoami`, and `doctor`. Reference repositories and installed dependencies are design-time
sources only; rook must not read or depend on them at runtime.

## Locked decisions and rationale

1. **Commander v13 dispatch.** Use vit's small registration pattern because it keeps command help
   and handlers isolated: one executable, one root `Command`, and one `register(program)` per command
   (`/home/extro/projects/vit/bin/vit.js:1-7`; `/home/extro/projects/vit/src/cli.js:27-55`).
2. **Node-20 OAuth pin.** Use exact `@atproto/oauth-client-node` 0.3.16 because 0.4.x requires Node
   22 and violates rook's Node >=20.10 contract; 0.3.16 declares Node >=18.7 and pins core 0.5.14
   (`node_modules/@atproto/oauth-client-node/package.json:27-42`; `package.json:7-8`).
3. **Three deterministic secret files.** Keep durable identity separate from library-owned OAuth
   state/session so each lifecycle is explicit and multiple selected identities cannot collide.
4. **One atomic writer.** Same-directory temp + mode 0600 + rename is the smallest primitive that
   prevents partial secret files and makes replacement atomic.
5. **One identity selector.** Centralized precedence makes commands consistent and lets tests redirect
   every home/config access.
6. **Fresh welcome-mat JWTs.** Store the RSA identity key, not an enrollment bearer; fresh ToS-bound
   credentials tolerate ToS changes and match the reference's re-mint behavior
   (`/home/extro/projects/welcome-mat/test/e2e.mjs:175-217`).
7. **Earned doctor checks.** Every green line must come from a read-only observation; the fixed
   repository-push `not_checked` prevents an unsupported full-readiness claim.
8. **Biome 1.9.4.** One pinned formatter/linter keeps `make ci` small and matches the house tool
   (`/home/extro/projects/link-host/package-lock.json:19-31`).
9. **npm `files` allowlist.** Positive packaging selection is easier to audit than an expanding denylist
   and excludes tests/design material by default.

## Dependency and tooling baseline

- `package.json` pins `@atproto/oauth-client-node` to exact `0.3.16`, `env-paths` to exact `4.0.0`,
  allows Commander major 13 with `^13.0.0`, and pins dev-only Biome to exact `1.9.4`
  (`package.json:29-35`). The resolved tree is node OAuth **0.3.16**, core OAuth **0.5.14**,
  Commander **13.1.0**, env-paths **4.0.0**, and Biome **1.9.4**
  (`package-lock.json:209-248`, `package-lock.json:280-291`, `package-lock.json:456-485`).
- The installed graph has no dependency declaring Node >=22. Engine-bearing packages resolve at
  Node >=20 or lower; the OAuth node wrapper is >=18.7, Commander >=18, env-paths >=20, and Biome
  >=14.21.3 (`package-lock.json:246-248`, `package-lock.json:290-291`,
  `package-lock.json:461-462`, `package-lock.json:484-485`). Core 0.5.14 has no separate `engines`
  field; the node wrapper supplies the relevant >=18.7 floor
  (`node_modules/@atproto/oauth-client/package.json:18-40`;
  `node_modules/@atproto/oauth-client-node/package.json:27-42`).
- Scripts are exactly `format: biome format --write .`, `lint: biome lint .`,
  `check: biome check .`, `test: node --test`, and `ci: npm run check && npm run test`
  (`package.json:22-27`). Make exposes `install`, `format`, `lint`, `check`, `test`, `ci`, and `clean`,
  delegating each non-clean task to npm (`Makefile:1-22`).
- `biome.json` uses the 1.9.4 schema, disables VCS integration, ignores unknown files plus
  `node_modules`/`coverage`, enables tabs at width 100 and recommended lint, and selects JS double
  quotes/semicolons (`biome.json:1-27`). A direct Biome probe has confirmed that a shebang followed by
  an `AGPL-3.0-only` SPDX header and the `✦` glyph parses and checks successfully.
- Package metadata maps `rook` to `bin/rook.js` and allowlists only `bin/`, `src/`, `README.md`, and
  `LICENSE` (`package.json:18-21`). `.npmignore` is unnecessary because `files` is authoritative.
  Current `npm pack --dry-run --json` confirms docs, tests, Biome config, and node_modules are excluded;
  because this design stage forbids creating `bin/`/`src/`, their inclusion is an implementation-stage
  acceptance condition rather than a present claim.

## CLI surface and output

### Root dispatch and help

- `bin/rook.js` contains the Node shebang, then the mandatory AGPL SPDX line, imports `program` from
  `src/cli.js`, and calls `program.parse()`.
- `src/cli.js` builds the root `Command`, reads the package version, registers the four commands, and
  calls `.addHelpText("beforeAll", "rook ✦ on the job")`. Commander documents `beforeAll` as the
  global banner position and emits it before built-in help
  (`node_modules/commander/Readme.md:808-815`; `node_modules/commander/lib/command.js:2391-2416`,
  `node_modules/commander/lib/command.js:2541-2560`). A live Commander 13.1.0 probe produced first
  line exactly `rook ✦ on the job`, followed by `Usage: rook ...`. Acceptance tests invoke the real
  `rook --help`; `helpInformation()` alone is insufficient because it omits custom help events.
- **`--identity <path>` is a GLOBAL option registered ONCE on the root `Command`** (via
  `.option("--identity <path>", ...)` on `program`), NOT duplicated on each subcommand, so
  `rook --identity <path> whoami` (root-before-subcommand) works. Each handler retrieves it through
  Commander's global-option accessor `command.optsWithGlobals()`, then feeds it to
  `resolveIdentityPath`. `--json` is defined per subcommand (command-local). Tests must pin both that
  the global `--identity` before the subcommand takes effect and its precedence versus
  `ROOK_IDENTITY_FILE`/default.

### Commands

- `rook [--identity <path>] enroll --invite <url> --handle <name> [--json]` requires BOTH `--invite`
  and `--handle` to enroll (syntactically options, but the command errors if either value is absent).
  `--identity` is the global root option shown above; `--json` is command-local.
  The invite URL is a secret: the command must never print, log, or place it (or its fragment) in
  output, errors, or the argv of any child process rook spawns. rook receiving it on its OWN argv via
  `--invite` is the required contract — the secret rule governs echo/log/error and CHILD-process argv,
  not rook's own option surface. `<name>` (the `--handle` value) is the single dotless handle label the
  service expects (`/home/extro/projects/rookery/src/worker.ts:1194-1203`).
- `rook [--identity <path>] login [--json]` restores/adopts the selected identity's session first, then
  performs a fresh fully headless consent flow only when restore fails or granted scope is insufficient.
- `rook [--identity <path>] whoami [--json]` is local-only: validate and report `did`, `handle`, and
  `serviceOrigin`; do not restore, refresh, or make network calls. Doctor owns live validation.
- `rook [--identity <path>] doctor [--json]` executes the ordered read-only checks defined below.
- All handlers accept injectable streams for tests. Each handler reads the global `--identity` via
  `optsWithGlobals()` and its own `--json` via local opts, then passes the identity value to
  `resolveIdentityPath`; command code never reconstructs path precedence and never redefines
  `--identity` locally.

### Structured output contract

- Normal success is exactly `{ok:true,...commandFields}` on stdout. Normal failure is exactly
  `{ok:false,error,causes?,hint?}` on stdout with exit code 1. Human-readable normal output goes to
  stdout, errors go to stderr, and `vlog = opts.json ? console.error : console.log` moves all progress
  and verbose text to stderr when JSON is active, preserving pure JSON stdout
  (`/home/extro/projects/vit/src/lib/json-output.js:11-37`;
  `/home/extro/projects/vit/src/cmd/follow.js:16-26`).
- Enroll success fields are `did`, `handle`, `serviceOrigin`, `identityPath`, and `existing`; no invite,
  key, proposed access token, or server body is returned. Login success fields are `did`, `handle`,
  `serviceOrigin`, `scope`, `expiresAt`, and `restored`. Whoami success fields are `did`, `handle`,
  `serviceOrigin`, and `identityPath`.
- Doctor completion is `{ok:true,overall:{status,verdict},checks}` even when health is failed; here
  `ok` means the diagnostic run completed, while `overall.status` and the process exit code are the
  health authority. **Exit code 1 whenever `overall.status` is `fail` OR `degraded`** — doctor must
  never return a success exit while any observed check is degraded (never turn a not-verified/degraded
  state into success-looking output). Exit code 0 only when every earned check is `ok` and the sole
  remaining status is the fixed `repository-push` `not_checked` (overall `not_checked`). Only an
  unexpected failure that prevents the runner from producing its check list uses
  `{ok:false,error,causes?,hint?}`. This keeps the base JSON envelopes exact without discarding
  structured failed-check evidence.
- Every object and message passes through `redact()` immediately before serialization/printing.

## Paths, schemas, and atomic storage

### Identity selection and derivation

`src/lib/paths.js` owns `resolveIdentityPath(opts, env, cwd)` with strict precedence:

1. `opts.identity` from `--identity <path>`;
2. `env.ROOK_IDENTITY_FILE`;
3. `join(envPaths("rook", {suffix:""}).config, "identity.json")`.

Explicit/env paths are normalized to absolute paths from injected `cwd`; empty values are rejected.
Given absolute identity path `P`, let `ext = extname(P)` and `stem = ext ? P.slice(0,-ext.length) : P`.
The canonical session path is exactly `stem + ".session.json"`; state is exactly
`stem + ".state.json"`. Thus default `identity.json` yields `identity.session.json` and
`identity.state.json`, while `alice.json` and `bob.json` cannot collide. A no-extension `alice` yields
`alice.session.json`/`alice.state.json`.

### Exact files

- Identity file: `{version:1,did,handle,serviceOrigin,rsaPrivateKeyPem,rsaPublicJwk:{kty,n,e},createdAt}`.
  `createdAt` is an ISO-8601 UTC string. `serviceOrigin` must equal `new URL(value).origin`; identity
  validation reparses the PKCS#8 PEM, requires RSA modulus 4096, derives its public JWK, and requires
  exact `kty/n/e` equality. This detects key/JWK substitution rather than merely checking fields.
- Session file: `{[did]:{dpopJwk,authMethod,tokenSet:{iss,sub,aud,scope,access_token,
  refresh_token?,token_type,expires_at?}}}`. It is passed directly through the library's
  `NodeSavedSessionStore`; the node adapter exports `dpopKey.privateJwk` to `dpopJwk`
  (`node_modules/@atproto/oauth-client-node/dist/node-dpop-store.d.ts:4-20`;
  `node_modules/@atproto/oauth-client-node/dist/node-dpop-store.js:9-26`). Core 0.5.14 permits
  legacy-optional `authMethod`, but rook-created entries always include it
  (`node_modules/@atproto/oauth-client/dist/session-getter.d.ts:11-19`). `authMethod` is exactly
  `{method:"none"}` for rook's public client (the alternative library shape is
  `{method:"private_key_jwt",kid}`), and ES256 `dpopJwk` contains the private `d` member
  (`node_modules/@atproto/oauth-client/dist/oauth-client-auth.d.ts:6-12`;
  `node_modules/@atproto/jwk/dist/jwk.d.ts:233-261`).
- State file: `{[state]:{iss,dpopJwk,authMethod,verifier,appState?}}`, passed through
  `NodeSavedStateStore` (`node_modules/@atproto/oauth-client/dist/state-store.d.ts:4-12`;
  `node_modules/@atproto/oauth-client-node/dist/node-dpop-store.d.ts:17-20`). It is transient and
  contains the OAuth DPoP private key plus PKCE verifier.
- DID strings such as `did:plc:...` are safe JSON object keys: JSON escaping preserves them and the
  colon-bearing DID grammar cannot equal prototype names. Map code still uses own-property checks (or
  null-prototype objects) and never trusts inherited properties.

All three are secrets and must be mode 0600. Directories are created recursively with requested mode
0700; existing directory permissions are not silently rewritten.

### Atomic primitive and stores

`src/lib/storage.js` owns one `atomicWriteFile(path, data, fsOps)`:

- create a same-directory temp named `<basename>.tmp.<pid>.<counter>`; the process-local monotonic
  counter is deterministic and prevents same-process collisions, `pid` separates processes, and open
  uses exclusive `wx`;
- open/write with 0600, explicitly `chmod(0600)`, optionally `sync()`, close, then rename over the
  target; rename is same-directory and atomic;
- close and unlink the temp on pre-rename failure, propagate the original cause, and never report
  success for partial persistence.

Identity writes and map-store `set`/nonempty `del`/`clear` all serialize with a trailing newline and use
this primitive. `get` treats only ENOENT as missing; malformed JSON or any other filesystem error is a
hard error. `del` atomically rewrites the remaining map, or unlinks when empty; ENOENT is idempotent.
Every successful write reasserts 0600 even when replacing an overly broad existing file.

State TTL is one hour, injected-clock based. Because the exact library value schema has no timestamp,
rook supports one active authorization state per selected identity: OAuth orchestration clears the
state store before `authorize`, `set` replaces it with the single new entry, and store age is the state
file's `mtime`. `get`/`set`/`del` first discard a file older than 3600 seconds. The library itself only
calls state `set`, `get`, and `del` and provides no expiry
(`/home/extro/projects/vit/node_modules/@atproto/oauth-client/dist/oauth-client.js:155-162`,
`/home/extro/projects/vit/node_modules/@atproto/oauth-client/dist/oauth-client.js:232-243`).

## Welcome-mat cryptography and enrollment

### Shared byte shapes

`src/lib/welcome-mat.js` is the only implementation of these operations; both enroll and login import
it. Clock, UUID source, and crypto may be injected for exact offline assertions.

- `base64urlEncode(bytes)` is unpadded Node `base64url`, never ordinary base64
  (`/home/extro/projects/welcome-mat/test/e2e.mjs:11-15`).
- `generateRsa4096()` creates exactly RSA-4096, public SPKI PEM and private unencrypted PKCS#8 PEM
  (`/home/extro/projects/welcome-mat/test/e2e.mjs:17-26`).
- `pemToJwk(publicPem)` returns only `{kty,n,e}` in that insertion order
  (`/home/extro/projects/welcome-mat/test/e2e.mjs:28-32`).
- `computeJwkThumbprint(jwk)` is
  `base64url(sha256(UTF8(JSON.stringify({e:jwk.e,kty:"RSA",n:jwk.n}))))`; the `e,kty,n` order is
  mandatory RFC 7638 canonical input (`/home/extro/projects/welcome-mat/test/e2e.mjs:76-82`).
- `signTos(text, privatePem)` signs the exact raw response string's UTF-8 bytes using
  RSASSA-PKCS1-v1_5/SHA-256 and returns unpadded base64url signature bytes
  (`/home/extro/projects/welcome-mat/test/e2e.mjs:67-74`;
  `/home/extro/projects/welcome-mat/spec.md:109-113`).
- `createAccessToken` uses header insertion order `{typ:"wm+jwt",alg:"RS256"}` and payload insertion
  order `{jti,tos_hash,aud,cnf,iat}` where `tos_hash=base64url(sha256(UTF8(tosText)))`,
  `aud=serviceOrigin`, `cnf={jkt}`, and `iat=floor(now/1000)`. Header and payload JSON are separately
  base64url encoded; ASCII `header.payload` is RSA/SHA-256 signed
  (`/home/extro/projects/welcome-mat/test/e2e.mjs:34-46`,
  `/home/extro/projects/welcome-mat/test/e2e.mjs:84-100`).
- `createDpopProof` uses header insertion order `{typ:"dpop+jwt",alg:"RS256",jwk}` and payload order
  `{jti,htm,htu,iat}` with optional `ath` appended last. `ath` is
  `base64url(sha256(UTF8(exactAccessTokenString)))`; signup omits it, authenticated consent includes it
  (`/home/extro/projects/welcome-mat/test/e2e.mjs:48-65`;
  `/home/extro/projects/welcome-mat/spec.md:155-173`). `htu` is origin + pathname only, never query or
  fragment (`/home/extro/projects/rookery/src/auth.ts:163-167`).

The welcome-mat RSA key is distinct from the OAuth library's per-session ES256 DPoP key. OAuth
`authorize()` generates and state-persists its own DPoP key before PAR
(`/home/extro/projects/vit/node_modules/@atproto/oauth-client/dist/oauth-client.js:152-162`), while
rookery requires RSA-4096/RS256 for enrollment and signed consent
(`/home/extro/projects/rookery/src/worker.ts:131-155`).

### Enrollment flow

1. Parse argv for `--invite` and `--handle`; both are required and the command errors if either value
   is absent (parsing argv is not network I/O). Then resolve the identity path and inspect it before
   any network I/O. A valid existing identity is a zero-network no-op (`existing:true`); a
   malformed/incomplete identity fails closed before network. Never overwrite it implicitly.
2. Take the `--invite` URL value (never echoed). Require HTTPS, take its `.origin` as
   `serviceOrigin`, and never retain/log the fragment outside the request body. Fetch
   `<serviceOrigin>/.well-known/welcome.md` and require a successful supported welcome document; the
   current server exposes `/tos` and `/api/signup` there
   (`/home/extro/projects/rookery/src/worker.ts:131-170`,
   `/home/extro/projects/rookery/src/worker.ts:496-500`).
3. Validate the `--handle` value `<name>` as a dotless label locally, generate RSA-4096, and GET
   `<serviceOrigin>/tos` as raw text. Rookery serves the exact current ToS at that endpoint
   (`/home/extro/projects/rookery/src/worker.ts:969-975`).
4. Sign ToS, mint a fresh proposed `wm+jwt`, and create signup DPoP with `htm:"POST"`,
   `htu:<serviceOrigin>/api/signup`, and no `ath`.
5. POST JSON `{handle:name,tos_signature,access_token,ref:originalInviteUrl}` plus `DPoP` and JSON
   content type. The server validates proof/ToS/token before invite handling and returns success
   `{did,handle,access_token,token_type:"DPoP"}`
   (`/home/extro/projects/rookery/src/worker.ts:1112-1192`,
   `/home/extro/projects/rookery/src/worker.ts:1300`). Validate 200 JSON, DID/handle strings, and DPoP
   token type; compare the echoed proposed token without printing it, then discard it permanently.
6. Only after valid HTTP 200, build the identity object and atomically persist it 0600. The identity
   file never contains the proposed enrollment bearer. Report success without any invite/token/key.

### Exact invite outcome wording

Invite availability and spend are separate: validation is before the atomic pending spend; successful
provisioning finalizes the DID, and provisioning exceptions attempt rollback
(`/home/extro/projects/rookery/src/worker.ts:1175-1251`,
`/home/extro/projects/rookery/src/worker.ts:1281-1300`;
`/home/extro/projects/rookery/src/directory.ts:219-256`). Use these exact classifications:

- Valid 200: **“Enrollment succeeded; the invite was consumed.”**
- Recognized pre-consumption response (`InvalidRequest`, `AuthRequired`, `AuthFailed`,
  `InvalidSignature`, `InvalidToken`, `InviteRequired`, `InviteInvalid`, `InvalidHandle`,
  `HandleReserved`, or `HandleTaken`): **“Enrollment was rejected before this attempt consumed an
  invite: <redacted reason>.”**
- `403 InviteInvalid` specifically: **“The invite is invalid or already spent; the service does not
  distinguish which. This attempt did not consume it.”** The database deliberately collapses absent,
  pending, and spent into one unavailable result
  (`/home/extro/projects/rookery/src/worker.ts:1186-1190`;
  `/home/extro/projects/rookery/src/directory.ts:219-225`). Never say it remains usable.
- Transport failure, malformed response, unknown error, or 5xx after POST: **“Enrollment outcome is
  undetermined; the invite may have been consumed. Do not retry with a new invite.”**
- Remote 200 followed by local identity-write failure: **“Enrollment succeeded remotely, but rook
  could not save the local identity at <path>. The invite was consumed and the remote account may be
  unrecoverable because its private key was not persisted. Do not retry with a new invite.”** Preserve
  the storage cause after redaction and exit nonzero.

## OAuth client, scope authority, and login

### Served client metadata is the only scope authority

For every login and doctor run, call
`NodeOAuthClient.fetchMetadata({clientId:new URL("/client-metadata.json",serviceOrigin),fetch})`. The
actual installed helper requires 200 JSON and schema-validates it
(`/home/extro/projects/vit/node_modules/@atproto/oauth-client/dist/oauth-client.js:27-46`). Require its
`client_id` to equal that URL and use the returned object unchanged as `clientMetadata`.

The current served scope is:

`atproto transition:generic repo:sh.tangled.repo repo:sh.tangled.repo.pull blob:*/* rpc:sh.tangled.repo.create?aud=did:web:knot.rook.host rpc:sh.tangled.git.receivePack?aud=did:web:knot.rook.host`

(`/home/extro/projects/rookery/src/worker.ts:261-272`; pinned by
`/home/extro/projects/rookery/test/commons.test.ts:343-365`). This literal is documentation only: **no
implementation or test helper may define a scope constant**. Login calls
`authorize(identity.did,{scope:metadata.scope})`; doctor independently re-fetches metadata. A scope is
sufficient iff every whitespace-delimited served token is in the whitespace-delimited granted
`getTokenInfo(false).scope` set; extra granted tokens are harmless. Missing any served token is
insufficient, and either knot `rpc:` token is mandatory.

The metadata's redirect URI is `http://127.0.0.1/callback`
(`/home/extro/projects/rookery/src/worker.ts:267-270`). No listener is created because rook captures the
manual 302 before fetch follows the loopback redirect.

### Prior-session-intact invariant: source result and transaction

Core 0.5.14 callback deletes pending **state**, exchanges the code, then calls session `set`; it does not
delete an existing session first. A token-exchange failure never touches the session, and a failed
session `set` revokes the newly issued token
(`/home/extro/projects/vit/node_modules/@atproto/oauth-client/dist/oauth-client.js:226-280`). Direct
callback replacement would therefore be safe with an atomic map write.

Refresh is not safe to run against the canonical file: a `TokenRefreshError` (including
`invalid_grant`) satisfies `deleteOnError`, and `CachedGetter` calls session `del` before rethrowing
(`/home/extro/projects/vit/node_modules/@atproto/oauth-client/dist/session-getter.js:87-98`,
`/home/extro/projects/vit/node_modules/@atproto/oauth-client/dist/session-getter.js:128-197`;
`/home/extro/projects/vit/node_modules/@atproto-labs/simple-store/dist/cached-getter.js:81-102`). A
successful refresh calls `set`; write failure revokes new credentials and throws
(`/home/extro/projects/vit/node_modules/@atproto/oauth-client/dist/session-getter.js:116-127`,
`/home/extro/projects/vit/node_modules/@atproto/oauth-client/dist/session-getter.js:179-192`).

Therefore all login mutation uses a `LoginStorageTransaction` in `src/lib/storage.js`:

- create unique same-directory sibling staging paths using pid + counter;
- copy canonical session bytes **byte-for-byte** to the staging session, or write `{}` if absent;
- use an empty staging state store; create both library stores over mutable path holders initially
  pointing at staging;
- run restore and, if needed, authorize/callback only against staging;
- on any failure, remove staging files and leave canonical session/state byte-for-byte untouched;
- **NEVER promote a restored session until scope sufficiency is confirmed.** The prior-session
  byte-for-byte preservation invariant (acceptance §5) OUTRANKS durably capturing a one-use refresh
  rotation. After a successful restore with DID equality + nonexpired token info, promote (atomic
  rename of the 0600 staging session over canonical) **only if** the restored scope is sufficient. If
  the restored scope is INSUFFICIENT, discard/roll back that restore staging (canonical untouched,
  byte-for-byte) and begin a NEW staging transaction copied fresh from canonical for the fresh-login
  path — do not carry the refreshed-but-insufficient staging session forward as canonical;
- after a fresh callback, require DID equality, token info, and served-scope sufficiency, THEN perform
  the atomic promotion — canonical is replaced only after a fully successful+validated fresh exchange;
- rebind the mutable session-store path holder to canonical immediately after a promotion rename so the
  already returned `OAuthSession` continues to read/write the durable file; discard the staging state
  because callback consumed it. Canonical state is not promoted.

This single transaction covers both risky refresh and safe callback without two code paths. Consequence
of the ordering above: a refresh that rotated a one-use token inside staging but was then rolled back
(insufficient scope) leaves canonical holding the pre-rotation (now remotely stale) bytes — that is the
accepted trade in the open risks; the recovery is the fresh headless login that immediately follows. The
byte-for-byte invariant on fresh-login failure always holds. If refresh
consumed a one-use remote token and a staging write fails, canonical bytes still satisfy the required
byte invariant but may represent a remotely invalid refresh token; login must then perform fresh
authorization, never claim restore succeeded.

### End-to-end login

1. Resolve/read/fully validate identity. Missing or malformed identity fails before OAuth network with
   recovery `run rook enroll --invite <url> --handle <name>` or repair the selected file; never infer
   identity from session.
2. Fetch current served client metadata and require a nonempty scope. Start a storage transaction and
   construct `NodeOAuthClient` with served metadata, staging stores, injected fetch, and an in-process
   request lock. Input to `authorize()` is the stored `did:plc:...`; core accepts DID and resolves its
   PDS/AS through identity and protected-resource discovery
   (`/home/extro/projects/vit/node_modules/@atproto/oauth-client/dist/oauth-resolver.js:28-37`,
   `/home/extro/projects/vit/node_modules/@atproto/oauth-client/dist/oauth-resolver.js:66-71`).
3. Attempt `client.restore(did)` first against staging. On success call `session.getTokenInfo(false)`,
   require `sub===did` and not expired, then compare scope BEFORE any promotion. If the restored scope
   is **sufficient**, promote the staging session atomically over canonical (durably recording any
   refresh rotation) and report `restored:true`. If the restored scope is **insufficient**, roll back
   the restore staging WITHOUT touching canonical bytes and begin fresh login from a NEW staging copy
   made fresh from canonical — do NOT promote the refreshed-but-insufficient session. On a
   missing/invalid restore, roll back without touching canonical bytes and begin fresh login from a new
   staging copy. This ordering guarantees that if the subsequent fresh authorization/exchange fails, the
   canonical session file is byte-for-byte unchanged (acceptance §5).
4. Fresh login clears staging state, calls `authorize(did,{scope:metadata.scope})`, and receives the AS
   `authorization_endpoint?client_id=...&request_uri=...` because core performs PAR internally
   (`/home/extro/projects/vit/node_modules/@atproto/oauth-client/dist/oauth-client.js:143-191`).
5. GET the returned URL without auth. Require 200 JSON `consent_request`; validate client ID equals
   served metadata, scope token set equals requested served scope, redirect URI is registered metadata,
   and any login hint agrees with stored DID/handle. Any mismatch is a local policy failure and no
   signed request is sent. Rookery's preview shape is defined at
   `/home/extro/projects/rookery/src/worker.ts:636-662`.
6. Freshly GET `<serviceOrigin>/tos`; mint a fresh `wm+jwt`. Build consent DPoP with `htm:"GET"`,
   `htu=authorizeUrl.origin+authorizeUrl.pathname` only, and
   `ath=base64url(sha256(exactWmJwt))`. Re-GET the **same authorize URL** with
   `Authorization: DPoP <wm+jwt>`, `DPoP: <proof>`, and `redirect:"manual"`. Never include query in
   `htu` (`/home/extro/projects/rookery/src/auth.ts:163-167`).
7. Require 302. For a non-302, parse only allowlisted OAuth/error fields, redact, and fail clearly; do
   not include URL, headers, body, JWT, or proof. Parse absolute `Location` with `new URL(location)` and
   take `.searchParams`. If `error=access_denied`, call `callback(params)` to consume staging state,
   catch its sanitized error, rollback, and report **“Authorization was denied.”** Other OAuth errors
   are similarly passed to callback for library state handling, then sanitized. Rookery returns
   `code`, `state`, and `iss` on grant or `error=access_denied`, `state`, and `iss` on deny
   (`/home/extro/projects/rookery/src/worker.ts:704-733`).
8. Call `client.callback(params)`. Require `session.did===identity.did`; call
   `getTokenInfo(false)`, require subject/DID, nonexpired token, and served-scope subset. On mismatch,
   revoke the staging session if safely possible, rollback, and fail. On success promote, report
   `restored:false`, and never expose tokens/DPoP keys.

## Doctor

Each check yields exactly `{name,status,detail,recovery?}` with status one of `ok`, `degraded`, `fail`,
or `not_checked`. Execute all checks whose prerequisites are earned; one failure must not suppress
independent later checks. Ranking is `fail > degraded > not_checked > ok`; `not_checked` is never
green.

1. **`identity-integrity`.** Require present/parseable strict v1 identity, required fields, RSA private
   key/JWK match, DID, handle, canonical origin, and timestamp. Missing/malformed/key mismatch is
   `fail`; no network is attempted for dependent checks.
2. **`secret-permissions`.** `stat` every existing identity/session/state file and require
   `(mode & 0o777) === 0o600`. Wider mode is `degraded`, detail names paths/modes, and recovery is exact
   shell-safe `chmod 600 -- <path>` (one command per affected file). Absent transient state is normal;
   absent session is handled by the session check. This check can never be `ok` while any existing
   secret file is broad.
3. **`handle-did-resolution`.** GET the stored `did:plc` document from PLC, require its normalized
   `alsoKnownAs` advertises `at://<storedHandle>`, then resolve the handle back via
   `https://<handle>/.well-known/atproto-did` and require the stored DID. Rookery exposes the latter
   read-only endpoint (`/home/extro/projects/rookery/src/worker.ts:1554-1570`). Mismatch is `fail`;
   timeout/network/non-200 is `degraded` because identity could not be verified. This mirrors the
   installed resolver's bidirectional rule
   (`node_modules/@atproto-labs/identity-resolver/dist/atproto-identity-resolver.js:37-52`,
   `node_modules/@atproto-labs/identity-resolver/dist/atproto-identity-resolver.js:66-83`).
4. **`session-restore-expiry`.** Use the same staging transaction and `restore(did)`, then
   `getTokenInfo(false)`; detail reports ISO `expiresAt`/`expired` without tokens. Missing session is
   `degraded` with recovery `run rook login`; invalid/unrefreshable session is `fail` with the same
   recovery. Promote a healthy restored session immediately after DID/expiry validation so a one-use
   refresh rotation is durable, rebind it to canonical storage, and retain it for later authenticated
   checks; later scope failure does not roll back a successful refresh. Client construction requires
   served metadata: if that fetch is unavailable/malformed while a local session exists, this check is
   `degraded` with detail `could not validate session because client metadata is unavailable`, not a
   false token failure.
5. **`granted-scope`.** Re-fetch served client metadata through `fetchMetadata`; compare served subset
   to granted set and list missing tokens. Missing any served token, including either knot RPC, is
   `fail` with recovery `run rook login`. Metadata unreachable/malformed is `degraded`; no restored
   session with otherwise valid metadata makes this `not_checked`. There is no hardcoded expected
   scope.
6. **`knot-membership`.** From the served `rpc:` tokens, require one common `aud`, parse
   `did:web:knot.rook.host` to host `knot.rook.host`, and use that host both as HTTPS origin and
   `subject`; never hardcode a second knot source. Exhaustively GET
   `/xrpc/sh.tangled.knot.listMembers?subject=<host>&limit=1000&order=asc`, add all
   `items[].subject`, and follow each returned `cursor` until absent. The lexicon requires subject,
   permits limit through 1000, and returns `items` plus optional cursor
   (`/home/extro/projects/aerie/lexicons/knot/listMembers.json:3-46`); handler items expose member DID in
   `subject` (`/home/extro/projects/aerie/knotserver/xrpc/list_members.go:12-46`). Repeated cursors,
   malformed JSON/items, timeout, unreachable, or non-200 are `degraded` with detail
   `could not verify membership`; exhaustive DID absence is `fail` with recovery
   `contact rook.host support to repair knot membership for <did>`.
7. **`service-auth-repo-create`** and **`service-auth-receive-pack`.** For each NSID
   `sh.tangled.repo.create` and `sh.tangled.git.receivePack`, use the restored session's authenticated
   fetch for GET
   `<serviceOrigin>/xrpc/com.atproto.server.getServiceAuth?aud=<derived-knot-did>&lxm=<nsid>&exp=<floor(now/1000)+60>`.
   Server requires integer `exp > now` and `exp <= now+300`
   (`/home/extro/projects/rookery/src/worker.ts:1491-1515`). HTTP 200 with a string `token` is `ok`, but
   discard/redact it immediately. Exact 403 `{error:"InsufficientScope",message:...}` is `fail` naming
   the corresponding missing served RPC scope; 401 is `fail` with `run rook login`; network/5xx is
   `degraded`. Minting only signs `{aud,lxm,exp}` and neither creates a repo nor pushes
   (`/home/extro/projects/rookery/src/worker.ts:1543-1552`;
   `/home/extro/projects/rookery/src/account-do.ts:112-137`).
8. **`repository-push`.** Always exactly `status:"not_checked"`,
   `detail:"deferred to git-workflow lode"`, with no recovery. Doctor never probes or claims push.

Overall verdict wording is exact:

- any fail: **“identity/auth diagnostics failed; repository push readiness not checked (deferred to
  git-workflow lode)”**;
- otherwise any degraded: **“identity/auth diagnostics degraded; repository push readiness not checked
  (deferred to git-workflow lode)”**;
- otherwise any non-repository `not_checked`: **“identity/auth diagnostics incomplete; repository push
  readiness not checked (deferred to git-workflow lode)”**;
- only the fixed repository check is `not_checked`: **“identity/auth checks passed; repository push
  readiness not checked (deferred to git-workflow lode)”**.

Overall status is respectively `fail`, `degraded`, or `not_checked`; it is never `ok` in this lode.

## Redaction and errors

`src/lib/redact.js` supplies one recursive `redact(value)` used by both `error-format` and `json-output`.
Defense is layered:

- command output objects are allowlisted DTOs; arbitrary response/request/error objects are never
  serialized;
- exact case-insensitive secret field names are replaced, including `rsaPrivateKeyPem`, private JWK
  `d`, `access_token`, `refresh_token`, `authorization`, `dpop`, `token`, `code`, `tos_signature`, and
  invite/ref fields; safe names such as `token_type`, `scope`, and `error` remain;
- strings scrub PEM private-key blocks, compact JWTs, `rkat_`/`rkrt_` tokens, Authorization/DPoP header
  values, OAuth `code=` query values, and URL fragments. Causes are walked only after redaction, with
  cycle/depth bounds matching vit's error pattern
  (`/home/extro/projects/vit/src/lib/error-format.js:4-78`).

Do not log raw fetch URL for enrollment (it contains the invite fragment), request headers, consent
URL query, callback `Location`, server token bodies, or OAuth store values. Enroll never echoes the
`--invite` URL or its fragment under human, JSON, verbose, error, or stack output, and never forwards it
to a spawned child process's argv. Tests install unique canary
secrets for every class, capture **both stdout and stderr** for every command and failure branch, and
assert no raw or encoded canary survives.

## Module and file plan

- `bin/rook.js`: executable entry only; shebang/SPDX/import/parse.
- `src/cli.js`: root Commander setup, exact help banner, version, common conventions, command
  registration.
- `src/cmd/enroll.js`: existing-identity gate, `--invite`/`--handle` option handling, enrollment orchestration, truthful
  outcome mapping. Inject streams, fetch, clock, UUID/crypto factory, and storage.
- `src/cmd/login.js`: restore-first/fresh headless orchestration and transaction promotion. Inject fetch,
  OAuth client factory, clock, and stores.
- `src/cmd/whoami.js`: local strict identity report only. Inject environment/cwd/storage.
- `src/cmd/doctor.js`: ordered check runner, dependency-aware `not_checked`, aggregation/verdict. Inject
  fetch, OAuth factory, clock, stat, and knot client.
- `src/lib/paths.js`: selector precedence and canonical/staging path derivation. Pure functions except
  injected `envPaths`/cwd.
- `src/lib/storage.js`: atomic writer, strict JSON read, 0600 map stores, state TTL, mutable backing path,
  and `LoginStorageTransaction`. Inject filesystem and clock.
- `src/lib/identity.js`: strict v1 schema/key consistency validation and safe public projection. Inject
  crypto only where tests need deterministic failures.
- `src/lib/welcome-mat.js`: all RSA/JWT/DPoP byte-shape functions. Inject clock, UUID, crypto.
- `src/lib/oauth.js`: `fetchClientMetadata`, client construction, scope-set comparison, RPC-scope parsing,
  in-process request lock, restore/callback helpers. Inject `NodeOAuthClient` factory and fetch.
- `src/lib/discovery.js`: welcome/ToS fetch, service-origin validation, PLC document and reverse-handle
  probes. Inject fetch and timeout signal factory.
- `src/lib/knot.js`: derive knot origin/subject from served RPC audience and exhaustively paginate
  membership with cursor-loop/malformed-response protection. Inject fetch.
- `src/lib/redact.js`: field-aware and string-pattern secret scrubber; no output side effects.
- `src/lib/json-output.js`: exact stdout JSON envelopes, redaction, exit status; inject stdout/process.
- `src/lib/error-format.js`: safe message/cause/hint formatting, always through redaction; inject no I/O.
- `test/cli.test.js`: real help first-line, dispatch/options, JSON stdout purity, and the global
  `--identity` accessor — assert `rook --identity <path> whoami` (root-before-subcommand) resolves that
  path via `optsWithGlobals()`, and that `--identity` is registered only on the root (not duplicated per
  subcommand).
- `test/paths-storage.test.js`: precedence, derivation, mode 0600, atomic failures, map deletion, TTL, and
  canonical byte preservation across restore/callback failure simulations.
- `test/welcome-mat.test.js`: deterministic decoded JSON member order, hashes, `ath` omission/presence,
  and signature verification against exact bytes.
- `test/enroll.test.js`, `test/login.test.js`, `test/whoami.test.js`, `test/doctor.test.js`: local HTTP
  servers/fakes only; cover all state classifications and no-network gates. `test/login.test.js` MUST:
  (a) use a fake `NodeOAuthClient` whose `callback(params)` returns the REAL 0.3.16 shape
  `{ session, state }` (NOT the session directly) and whose `restore()` returns the session directly,
  and prove a fresh headless login completes end-to-end through that destructured return; (b) assert
  byte-for-byte canonical session preservation when the prior session is restored, refresh-rotates
  during restore, is scope-INSUFFICIENT, and the subsequent fresh login then FAILS — the canonical
  session file bytes must equal the pre-run bytes exactly.
- `test/redact.test.js`: stdout+stderr canaries for all secret classes and commands.
- `scripts/pack-check.mjs` (NOT under `test/`, invoked via `npm run pack-check`): tarball allowlist +
  Node-20.10 Docker container acceptance. It MUST NOT be discoverable by the default `node --test` glob
  and MUST NOT be wired into `make ci`, because it uses Docker and the public npm registry while the
  `node --test` unit suite stays fully offline/fake-only (`AGENTS.md:35-40`). Run it on demand for the
  packaging acceptance.
- `README.md`: after implementation, document the four commands, the `--invite`/`--handle` option surface, identity
  selector precedence/default, JSON behavior, doctor caveat, Node >=20.10, and make targets without
  documenting secret file contents or example credentials.

No runtime module imports reference-repository paths. Tests redirect `HOME`, `XDG_CONFIG_HOME`, and
`ROOK_IDENTITY_FILE` to temporary directories and use local HTTP servers/injected fetch; they never
touch the real home directory (`AGENTS.md:35-40`).

## Implementation order and acceptance

1. Implement pure redaction/error/JSON and path derivation first; everything else depends on their
   safety and deterministic location rules.
2. Implement atomic storage, identity validation, state TTL, map stores, and login transaction; exhaust
   failure injection and byte-preservation tests before OAuth/network orchestration.
3. Implement and byte-test welcome-mat crypto.
4. Implement discovery and enroll, including zero-network existing identity and all invite outcome
   wording.
5. Implement OAuth metadata/scope helpers and transactional login; use local PAR/authorize/token fakes
   while exercising the actual pinned library.
6. Implement whoami, knot pagination, and doctor checks/aggregation.
7. Wire Commander executable/help and command output tests.
8. Run `make format`, `make ci` (offline: biome check + `node --test`, no Docker/network), then the
   separate `npm run pack-check` for packaging allowlist inspection and Node-20.10 acceptance.

Packaging acceptance (`scripts/pack-check.mjs`, run via `npm run pack-check`, NOT part of `make ci`)
must:

- run `npm pack --json` and inspect the tar list: it must include `package/bin/rook.js`, all required
  `package/src/**`, `README.md`, `LICENSE`, and package metadata; it must exclude `test/`, `docs/`,
  `biome.json`, coverage, and node_modules;
- clean-install the tarball inside exact image `node:20.10.0` (Docker 29.5.3 is available locally), set
  npm `engine-strict=true`, capture combined npm output, assert no `EBADENGINE`, invoke the installed
  `rook --help`, and assert first line exactly `rook ✦ on the job`;
- fail rather than skip when Docker/image/install/help is unavailable. This check may use the public npm
  registry for the clean install; unit tests remain local/fake-only.

## Open risks

- A remote enrollment can succeed before the first canonical identity write. The locked persist-after-200
  ordering means a local disk failure can leave an unrecoverable remote account; the exact error above
  must make this explicit and must never suggest spending another invite.
- OAuth refresh tokens are one-use. Staging preserves canonical bytes on failure, but a successful remote
  refresh followed by local staging-write failure can leave those preserved bytes remotely stale; fresh
  headless login is the recovery.
- The library request lock is process-local. Concurrent rook processes selecting the same identity can
  race staging promotions; implementation should use exclusive staging creation and fail clearly on a
  detected same-identity operation rather than last-writer-wins. A full interprocess lock is outside this
  lode unless tests demonstrate it is required.
- Exhaustive knot pagination is externally controlled. Cursor-cycle detection, response-size/timeouts,
  and malformed-page degradation are mandatory so “exhaustive” cannot become an unbounded loop.
