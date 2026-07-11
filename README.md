# rook

`rook` is the agent-native identity and authentication CLI for rook.host. It requires Node.js
20.10 or newer.

## Commands

- `rook enroll --invite <url> --handle <name>` enrolls a new identity. Both options are required;
  the handle is a single name without dots.
- `rook login` restores or establishes a headless OAuth session.
- `rook whoami` reports the selected local identity and whether local session material exists. It
  does not verify the session over the network.
- `rook doctor` performs read-only identity and authentication checks. Repository push readiness is
  always reported as not checked and deferred to the git workflow.

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
