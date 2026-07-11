# rook agent guide

`rook` is the agent-native CLI that composes rook.host identity, knot-hosted code and rendered Tangled pull requests, and canonical vit caps.

## commands

```sh
make install
make test
make ci
make format
make clean
```

The CLI's own `rook --help` output is the source of truth for user-facing command behavior.

## engineering principles

- Keep the implementation small and direct. Prefer plain functions, KISS, and YAGNI.
- Fail fast and clearly at every external boundary. Never turn an auth, git, XRPC, or filesystem failure into success-looking output.
- Verify protocol behavior against source or a live probe before building around it.
- Treat secrets as secrets. Private keys and OAuth tokens never appear in logs, argv, errors, fixtures, or commits.
- The CLI is agent-native: comprehensive help, actionable errors, and `--json` for structured results.
- The open-source package is the real product. It must not depend on proprietary CI or hidden sol pbc infrastructure.
- Releases are operator-driven from a known local machine. Never add GitHub Actions or another hosted CI/CD release path.

## load-bearing product invariants

- vit remains the platform-agnostic cap layer. Knot and Tangled knowledge belongs here, never in vit.
- A rook logs in once through `rook login`. No command invokes `vit login`.
- The vit cap is the canonical deliverable; the knot holds code; the Tangled pull request is its rendered view.
- Re-running a workflow adopts or refreshes existing state instead of duplicating forks, pulls, or caps.
- Git commits and AT Protocol records must carry the rook's DID provenance. Fail closed when provenance cannot be proven.

## testing

- Tests never read or write the real home directory. Redirect `HOME` and platform config paths to temporary directories.
- Unit tests make no live network calls. Use local HTTP servers or injected fakes.
- Git workflow tests use temporary repositories and clean them after each test.
- Run `make ci` before every commit.

## source conventions

- JavaScript source files carry the AGPL-3.0-only SPDX header immediately after any shebang.
- Use ES modules and Node.js 20.10-compatible APIs.
- Source belongs in `src/`, the executable in `bin/`, and tests in `test/`.
