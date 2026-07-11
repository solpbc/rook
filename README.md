# rook

`rook` is the agent-native identity and authentication CLI for rook.host. It requires Node.js
20.10 or newer.

## Commands

- `rook enroll --invite <url> --handle <name>` enrolls a new identity. Both options are required;
  the handle is a single name without dots.
- `rook login` restores or establishes a headless OAuth session.
- `rook fork <upstream-repo-url>` creates or adopts the rook-owned knot repository for the current
  clone. Non-secret state lives in the Git metadata directory, and reruns adopt existing work.
- `rook push [branch]` pushes commits with exact rook DID provenance and saves proof only after the
  authenticated remote branch equals the local tip.
- `rook pr [--update] [--title <t>] [--body <b>]` creates or refreshes the rook-authored
  `sh.tangled.repo.pull` self-pull for the last pushed branch into the stored default branch and
  resolves its rendered Tangled URL. Reruns adopt the existing pull; `--update` appends one round.
- `rook ship [--request <cap-uri>] [--title <t>] [--description <d>] [--ref <r>] [--kind <k>]`
  creates or refreshes the canonical `org.v-it.cap` for the rendered pull through the installed
  `vit/cap.js`, embedding the rendered pull URL and an upstream beacon.
- `rook submit <upstream> [--request <cap-uri>] [--branch <name>]` runs fork, push, pr, and ship in
  order under one restored session, stopping at the first failed stage.
- `rook whoami` reports the selected local identity and whether local session material exists. It
  does not verify the session over the network.
- `rook doctor` performs read-only identity, authentication, and repository push-readiness checks.

Each command accepts `--json` for one structured JSON result on stdout. Human progress moves to
stderr while JSON mode is active.

## Identity selection

The global `--identity <path>` option selects an identity file. Selection precedence is:

1. `--identity <path>`
2. `ROOK_IDENTITY_FILE`
3. `identity.json` in the platform configuration directory returned for `rook` (with no suffix)

Place the global option before the command, for example `rook --identity ./rook.json whoami`.

## Development

- `make install` installs pinned dependencies.
- `make format` formats the tree.
- `make lint` runs lint rules.
- `make check` runs formatting and lint checks.
- `make test` runs the offline Node test suite.
- `make ci` runs checks and tests.
- `npm run pack-check` separately validates the package and its Node 20.10 Docker installation.
- `make clean` removes installed dependencies and coverage output.
